import axios from "axios";
import zlib from "zlib";
import { promisify } from "util";
import prisma from "../config/prisma";

const gunzip = promisify(zlib.gunzip);

// Instrument data structure
export interface UpstoxInstrument {
    instrumentKey: string;      // e.g., "NSE_EQ|INE848E01016"
    exchangeToken: string;
    tradingSymbol: string;      // e.g., "RELIANCE"
    name: string;
    expiry: string | null;
    strike: number | null;
    instrumentType: string;     // e.g., "EQ", "FUTIDX", "OPTIDX"
    isin: string | null;
    exchange: string;           // "NSE" or "BSE"
}

let symbolKeyMap = new Map<string, string>();
let allInstruments: UpstoxInstrument[] = [];
let nseInstruments: UpstoxInstrument[] = [];
let bseInstruments: UpstoxInstrument[] = [];

export const upstoxInstrumentService = {
    loadExchangeInstruments: async (exchange: "NSE" | "BSE"): Promise<UpstoxInstrument[]> => {
        try {
            const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.csv.gz`;
            const response = await axios.get(url, {
                responseType: "arraybuffer",
            });

            const csvBuffer = await gunzip(response.data);
            const csvData = csvBuffer.toString("utf-8");

            const lines = csvData.split("\n");
            const instruments: UpstoxInstrument[] = [];

            for (const line of lines) {
                if (!line.trim()) continue;
                const cols = line.split(",");

                if (cols[0] === "instrument_key" || cols[0] === '"instrument_key"') continue;

                const cleanValue = (val: string) => val?.replace(/"/g, "").trim() || "";

                const instrumentKey = cleanValue(cols[0]);
                const exchangeToken = cleanValue(cols[1]);
                const tradingSymbol = cleanValue(cols[2]);
                const name = cleanValue(cols[3]);
                const expiry = cleanValue(cols[5]) || null;
                const strike = parseFloat(cleanValue(cols[6])) || null;
                const instrumentType = cleanValue(cols[9]);
                const isin = cleanValue(cols[10]) || null;
                const exchangeCol = cleanValue(cols[11]) || exchange;

                if (instrumentKey && tradingSymbol) {
                    instruments.push({
                        instrumentKey,
                        exchangeToken,
                        tradingSymbol,
                        name,
                        expiry,
                        strike,
                        instrumentType,
                        isin,
                        exchange: exchangeCol,
                    });
                }
            }

            return instruments.filter((inst) => ['NSE_EQ', 'BSE_EQ', 'NSE_FO'].includes(inst.exchange) && [null, '', 'CE', 'PE', 'FF'].includes(inst.isin) && ['EQUITY', 'OPTSTK', 'FUTSTK'].includes(inst.instrumentType));
        } catch (error: any) {
            console.error(`❌ Failed to load ${exchange} instruments:`, error.message);
            return [];
        }
    },

    loadInstruments: async (): Promise<void> => {
        try {
            const [nseData, bseData] = await Promise.all([
                upstoxInstrumentService.loadExchangeInstruments("NSE"),
                upstoxInstrumentService.loadExchangeInstruments("BSE"),
            ]);
            nseInstruments = nseData;
            bseInstruments = bseData;
            allInstruments = [...nseData, ...bseData];

            const tempMap = new Map<string, string>();
            for (const inst of allInstruments) {
                tempMap.set(inst.tradingSymbol, inst.instrumentKey);
            }
            symbolKeyMap = tempMap;

            console.log(`📈 Total instruments loaded: ${allInstruments.length} (NSE: ${nseInstruments.length}, BSE: ${bseInstruments.length})`);
        } catch (error: any) {
            console.error("❌ Failed to load Upstox instruments:", error.message);
        }
    },

    loadNseEqInstruments: async (): Promise<void> => {
        const nseData = await upstoxInstrumentService.loadExchangeInstruments("NSE");
        const data = nseData.filter((inst) => inst.instrumentType === "EQUITY");

        let successCount = 0;
        let errorCount = 0;

        for (const inst of data) {
            try {
                await prisma.instrument_lists.upsert({
                    where: {
                        exchange_instrument_type: {
                            instrument_type: inst.tradingSymbol,
                            exchange: "NSE",
                        },
                    },
                    update: {
                        upstox_id: inst.instrumentKey,
                        upstox_symbol: inst.tradingSymbol,
                    },
                    create: {
                        instrument_type: inst.tradingSymbol,
                        exchange: "NSE",
                        upstox_id: inst.instrumentKey,
                        upstox_symbol: inst.tradingSymbol,
                    },
                });
                successCount++;
            } catch (error: any) {
                errorCount++;
            }
        }
        console.log(`✅ NSE Equity sync complete: ${successCount} success, ${errorCount} errors`);
    },

    loadNseFutInstruments: async (): Promise<void> => {
        try {
            const nseData = await upstoxInstrumentService.loadExchangeInstruments("NSE");
            const equityData = nseData.filter((inst) => inst.instrumentType === "EQUITY");
            const futInstruments = nseData.filter((inst) => inst.instrumentType === "FUTSTK");

            if (futInstruments.length === 0) {
                console.log("⚠️ No FUTSTK instruments found");
                return;
            }

            let successCount = 0;
            let errorCount = 0;

            for (const inst of futInstruments) {
                try {
                    const underlying = equityData.filter((data) => data.name === inst.name)[0].tradingSymbol;
                    const instrumentRecord = await prisma.instrument_lists.findFirst({
                        where: {
                            exchange: "NSE",
                            instrument_type: underlying,
                        },
                        select: { id: true },
                    });

                    if (!instrumentRecord) {
                        errorCount++;
                        continue;
                    }

                    let expiryDate: Date | null = null;
                    if (inst.expiry) {
                        expiryDate = new Date(inst.expiry);
                    }

                    await prisma.symbols_list.upsert({
                        where: {
                            instrument_id_symbol: {
                                instrument_id: instrumentRecord.id,
                                symbol: inst.tradingSymbol,
                            },
                        },
                        update: {
                            upstox_id: inst.instrumentKey,
                            upstox_symbol: inst.tradingSymbol,
                        },
                        create: {
                            instrument_id: instrumentRecord.id,
                            symbol: inst.tradingSymbol,
                            segment: "FUT",
                            expiry_date: expiryDate,
                            upstox_id: inst.instrumentKey,
                            upstox_symbol: inst.tradingSymbol,
                        },
                    });
                    successCount++;
                } catch (error: any) {
                    errorCount++;
                    if (errorCount <= 5) {
                        console.error(`❌ Failed to upsert ${inst.tradingSymbol}:`, error.message);
                    }
                }
            }

            console.log(`✅ NSE Futures sync complete: ${successCount} success, ${errorCount} errors`);
        } catch (error: any) {
            console.error("❌ Failed to load NSE Futures instruments:", error.message);
        }
    },

    // loadNseOptInstruments: async (): Promise<void> => {
    //     const nseData = await upstoxInstrumentService.loadExchangeInstruments("NSE");
    //     const optInstruments = nseData.filter((inst) => inst.instrumentType === "OPTSTK");
    //     const eqInstruments = nseData.filter((inst) => inst.instrumentType === "EQUITY");

    //     let successCount = 0;
    //     let errorCount = 0;

    //     for (const inst of optInstruments) {
    //         try {
    //             const underlying = eqInstruments.filter((data) => data.name === inst.name)[0].tradingSymbol;
    //             const instrumentRecord = await prisma.instrument_lists.findFirst({
    //                 where: {
    //                     exchange: "NSE",
    //                     instrument_type: underlying,
    //                 },
    //                 select: { id: true },
    //             });

    //             if (!instrumentRecord) {
    //                 errorCount++;
    //                 continue;
    //             }

    //             let expiryDate: Date | null = null;
    //             if (inst.expiry) {
    //                 expiryDate = new Date(inst.expiry);
    //             }

    //             await prisma.symbols_list.upsert({
    //                 where: {
    //                     upstox_id: inst.instrumentKey,
    //                 },
    //                 update: {
    //                     upstox_id: inst.instrumentKey,
    //                     upstox_symbol: inst.tradingSymbol,
    //                 },
    //                 create: {
    //                     instrument_id: instrumentRecord.id,
    //                     symbol: inst.tradingSymbol,
    //                     segment: "OPT",
    //                     expiry_date: expiryDate,
    //                     upstox_id: inst.instrumentKey,
    //                     upstox_symbol: inst.tradingSymbol,
    //                 },
    //             });
    //             successCount++;
    //         } catch (error: any) {
    //             errorCount++;
    //             if (errorCount <= 5) {
    //                 console.error(`❌ Failed to upsert ${inst.tradingSymbol}:`, error.message);
    //             }
    //         }
    //     }

    //     console.log(`✅ NSE Options sync complete: ${successCount} success, ${errorCount} errors`);
    // },

    // loadBseEqInstruments: async (): Promise<void> => {
    //     await upstoxInstrumentService.loadExchangeInstruments("BSE");
    //     const data = bseInstruments.filter((inst) => inst.instrumentType === "EQUITY");
    //     console.log(bseInstruments[0])
    // },
}