import axios from "axios";
import zlib from "zlib";
import { promisify } from "util";
import prisma from "../config/prisma";
import { devLog, devWarn, devError, prodError } from "../utils/errorLogger";

const gunzip = promisify(zlib.gunzip);

// Instrument data structure
export interface UpstoxInstrument {
    instrumentKey: string;      // e.g., "NSE_EQ|INE848E01016"
    exchangeToken: string;
    tradingSymbol: string;      // e.g., "RELIANCE"
    name: string;
    expiry: string | null;
    strike: number | null;
    optionType: string | null;
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
                const optionType = cleanValue(cols[10]);
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
                        optionType,
                        instrumentType,
                        isin,
                        exchange: exchangeCol,
                    });
                }
            }

            return instruments.filter((inst) => ['NSE_EQ', 'BSE_EQ', 'NSE_FO'].includes(inst.exchange) && [null, '', 'CE', 'PE', 'FF'].includes(inst.isin) && ['EQUITY', 'OPTSTK', 'FUTSTK'].includes(inst.instrumentType));
        } catch (error: any) {
            devError(`❌ Failed to load ${exchange} instruments:`, error.message);
            prodError(`Failed to load ${exchange} instruments`);
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

            devLog(`📈 Total instruments loaded: ${allInstruments.length} (NSE: ${nseInstruments.length}, BSE: ${bseInstruments.length})`);
        } catch (error: any) {
            devError("❌ Failed to load Upstox instruments:", error.message);
            prodError("Failed to load Upstox instruments");
        }
    },

    loadNseEqInstruments: async (): Promise<void> => {
        try {
            const nseData = await upstoxInstrumentService.loadExchangeInstruments("NSE");
            const data = nseData.filter((inst) => inst.instrumentType === "EQUITY");

            let successCount = 0;
            let errorCount = 0;

            const chunkSize = 20;
            for (let i = 0; i < data.length; i += chunkSize) {
                const chunk = data.slice(i, i + chunkSize);
                await Promise.all(chunk.map(async (inst) => {
                    try {
                        const existingByUpstoxId = await prisma.instrument_lists.findUnique({
                            where: { upstox_id: inst.instrumentKey }
                        });

                        if (!existingByUpstoxId) {
                            const existingBySymbol = await prisma.instrument_lists.findUnique({
                                where: {
                                    exchange_instrument_type: {
                                        exchange: "NSE",
                                        instrument_type: inst.tradingSymbol,
                                    }
                                }
                            });

                            if (!existingBySymbol) {
                                await prisma.instrument_lists.create({
                                    data: {
                                        exchange: "NSE",
                                        instrument_type: inst.tradingSymbol,
                                        upstox_id: inst.instrumentKey,
                                        upstox_symbol: inst.tradingSymbol,
                                    }
                                });
                            }
                        }
                        successCount++;
                    } catch (error: any) {
                        errorCount++;
                        devError(`❌ Error syncing EQ ${inst.tradingSymbol}: ${error.message}`);
                    }
                }));
            }
            devLog(`✅ NSE Equity sync complete: ${successCount} success, ${errorCount} errors`);
        } catch (error: any) {
            devError("❌ Failed to sync NSE Equity:", error.message);
        }
    },

    loadNseFutInstruments: async (): Promise<void> => {
        try {
            const nseData = await upstoxInstrumentService.loadExchangeInstruments("NSE");
            const equityData = nseData.filter((inst) => inst.instrumentType === "EQUITY");
            const futInstruments = nseData.filter((inst) => inst.instrumentType === "FUTSTK");

            if (futInstruments.length === 0) {
                devLog("⚠️ No FUTSTK instruments found");
                return;
            }

            // Pre-fetch all instrument_lists to avoid repeated queries
            const existingInstruments = await prisma.instrument_lists.findMany({
                where: { exchange: "NSE" },
                select: { id: true, instrument_type: true }
            });
            const instrumentMap = new Map(existingInstruments.map(i => [i.instrument_type, i.id]));

            let successCount = 0;
            let errorCount = 0;

            const chunkSize = 20;
            for (let i = 0; i < futInstruments.length; i += chunkSize) {
                const chunk = futInstruments.slice(i, i + chunkSize);
                await Promise.all(chunk.map(async (inst) => {
                    try {
                        const underlyingEquity = equityData.find((data) => data.name === inst.name);
                        const underlying = underlyingEquity?.tradingSymbol || inst.name;

                        let instrumentId = instrumentMap.get(underlying);

                        if (!instrumentId) {
                            const existing = await prisma.instrument_lists.findUnique({
                                where: {
                                    exchange_instrument_type: {
                                        exchange: "NSE",
                                        instrument_type: underlying,
                                    }
                                },
                                select: { id: true }
                            });
                            
                            if (existing) {
                                instrumentId = existing.id;
                            } else {
                                const newInstrument = await prisma.instrument_lists.create({
                                    data: {
                                        exchange: "NSE",
                                        instrument_type: underlying,
                                    },
                                    select: { id: true }
                                });
                                instrumentId = newInstrument.id;
                            }
                            instrumentMap.set(underlying, instrumentId);
                        }

                        let expiryDate: Date | null = null;
                        if (inst.expiry) {
                            expiryDate = new Date(inst.expiry);
                        }
                        const expiryMonth = expiryDate ? expiryDate.toLocaleString('default', { month: 'long' }).toUpperCase() : null;

                        // Match by (instrument_id, symbol), not upstox_id: NSE_FO exchange tokens
                        // get recycled across expiries, so a stale token would false-match an old contract.
                        await prisma.symbols_list.upsert({
                            where: {
                                instrument_id_symbol: {
                                    instrument_id: instrumentId,
                                    symbol: inst.tradingSymbol,
                                }
                            },
                            update: {
                                upstox_id: inst.instrumentKey,
                                upstox_symbol: inst.tradingSymbol,
                                expiry_date: expiryDate,
                                expiry_month: expiryMonth,
                            },
                            create: {
                                instrument_id: instrumentId,
                                symbol: inst.tradingSymbol,
                                segment: "FUT",
                                expiry_date: expiryDate,
                                upstox_id: inst.instrumentKey,
                                upstox_symbol: inst.tradingSymbol,
                                expiry_month: expiryMonth,
                            }
                        });
                        successCount++;
                    } catch (error: any) {
                        errorCount++;
                    }
                }));
            }

            devLog(`✅ NSE Futures sync complete: ${successCount} success, ${errorCount} errors`);
        } catch (error: any) {
            devError("❌ Failed to load NSE Futures instruments:", error.message);
            prodError("Failed to load NSE Futures instruments");
        }
    },

    loadNseOptInstruments: async (): Promise<void> => {
        try {
            const nseData = await upstoxInstrumentService.loadExchangeInstruments("NSE");
            const optInstruments = nseData.filter((inst) => inst.instrumentType === "OPTSTK");
            const eqInstruments = nseData.filter((inst) => inst.instrumentType === "EQUITY");

            if (optInstruments.length === 0) {
                devLog("⚠️ No OPTSTK instruments found");
                return;
            }

            // 1. Pre-fetch all instrument_lists to avoid repeated queries
            const existingInstruments = await prisma.instrument_lists.findMany({
                where: { exchange: "NSE" },
                select: { id: true, instrument_type: true }
            });
            const instrumentMap = new Map(existingInstruments.map(i => [i.instrument_type, i.id]));

            let successCount = 0;
            let errorCount = 0;

            // Process in chunks to avoid overwhelming the database
            const chunkSize = 50;
            for (let i = 0; i < optInstruments.length; i += chunkSize) {
                const chunk = optInstruments.slice(i, i + chunkSize);
                
                await Promise.all(chunk.map(async (inst) => {
                    try {
                        const underlyingEquity = eqInstruments.find((data) => data.name === inst.name);
                        const underlying = underlyingEquity?.tradingSymbol || inst.name;

                        let instrumentId = instrumentMap.get(underlying);

                        if (!instrumentId) {
                            const existing = await prisma.instrument_lists.findUnique({
                                where: {
                                    exchange_instrument_type: {
                                        exchange: "NSE",
                                        instrument_type: underlying,
                                    }
                                },
                                select: { id: true }
                            });

                            if (existing) {
                                instrumentId = existing.id;
                            } else {
                                const newInstrument = await prisma.instrument_lists.create({
                                    data: {
                                        exchange: "NSE",
                                        instrument_type: underlying,
                                    },
                                    select: { id: true }
                                });
                                instrumentId = newInstrument.id;
                            }
                            instrumentMap.set(underlying, instrumentId);
                        }

                        let expiryDate: Date | null = null;
                        if (inst.expiry) {
                            expiryDate = new Date(inst.expiry);
                        }
                        const expiryMonth = expiryDate ? expiryDate.toLocaleString('default', { month: 'long' }).toUpperCase() : null;
                        const strike = inst.strike?.toString() || null;

                        // Match by (instrument_id, symbol), not upstox_id: NSE_FO exchange tokens
                        // get recycled across expiries, so a stale token would false-match an old contract.
                        await prisma.symbols_list.upsert({
                            where: {
                                instrument_id_symbol: {
                                    instrument_id: instrumentId,
                                    symbol: inst.tradingSymbol,
                                }
                            },
                            update: {
                                upstox_id: inst.instrumentKey,
                                upstox_symbol: inst.tradingSymbol,
                                expiry_date: expiryDate,
                                expiry_month: expiryMonth,
                                strike,
                                option_type: inst.optionType,
                            },
                            create: {
                                instrument_id: instrumentId,
                                symbol: inst.tradingSymbol,
                                segment: "OPT",
                                expiry_date: expiryDate,
                                upstox_id: inst.instrumentKey,
                                upstox_symbol: inst.tradingSymbol,
                                strike,
                                option_type: inst.optionType,
                                expiry_month: expiryMonth,
                            }
                        });

                        successCount++;
                    } catch (error: any) {
                        errorCount++;
                    }
                }));
            }

            devLog(`✅ NSE Options sync complete: ${successCount} success, ${errorCount} errors`);
        } catch (error: any) {
            devError("❌ Failed to load NSE Options instruments:", error.message);
            prodError("Failed to load NSE Options instruments");
        }
    },

    // loadBseEqInstruments: async (): Promise<void> => {
    //     await upstoxInstrumentService.loadExchangeInstruments("BSE");
    //     const data = bseInstruments.filter((inst) => inst.instrumentType === "EQUITY");
    //     devLog(bseInstruments[0])
    // },
}