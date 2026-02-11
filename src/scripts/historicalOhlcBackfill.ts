import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { loadEnv } from "../config/env";
import { logger } from "../utils/logger";

loadEnv();
const prisma = new PrismaClient();

// Rate limiting: max requests per second
const RATE_LIMIT_DELAY_MS = 200;

interface HistoricalCandle {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    oi: number;
}

interface InstrumentData {
    id: number;
    instrument_type: string;
    upstox_id: string;
}

interface SymbolData {
    id: number;
    instrument_id: number;
    symbol: string;
    segment: string;
    expiry_date: Date | null;
    upstox_id: string;
    strike: string | null;
    option_type: string | null;
    expiry_month: string | null;
}

/**
 * Fetch historical candle data from Upstox Historical Candle API
 * Note: Using V2 format as V3 has different parameter requirements
 * @param instrumentKey Upstox instrument key (e.g., "NSE_EQ|INE848E01016")
 * @param accessToken Upstox access token
 * @param fromDate Start date (YYYY-MM-DD format)
 * @param toDate End date (YYYY-MM-DD format)
 */
async function fetchHistoricalCandles(
    instrumentKey: string,
    accessToken: string,
    fromDate: string,
    toDate: string
): Promise<HistoricalCandle[]> {
    try {
        // Encode the instrument key for URL
        const encodedKey = encodeURIComponent(instrumentKey);
        // V2 Historical Candle API: /historical-candle/{instrument_key}/{interval}/{to_date}/{from_date}
        // interval: 1minute, 30minute, day, week, month
        const url = `${UPSTOX_CONFIG.BASE_URL}/historical-candle/${encodedKey}/day/${toDate}/${fromDate}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
            },
        });

        if (response.data.status === "success" && response.data.data?.candles) {
            // API returns: [timestamp, open, high, low, close, volume, oi]
            return response.data.data.candles.map((candle: any[]) => ({
                timestamp: candle[0],
                open: candle[1],
                high: candle[2],
                low: candle[3],
                close: candle[4],
                volume: candle[5],
                oi: candle[6] || 0,
            }));
        }

        return [];
    } catch (error: any) {
        // Only log first few errors to avoid spam
        if (error.response?.status !== 429) {
            logger.error(
                `❌ Failed to fetch historical data for ${instrumentKey}:`,
                error.response?.data?.errors || error.message
            );
        }
        return [];
    }
}

/**
 * Get all NSE Equity instruments with Upstox IDs
 */
async function getEquityInstruments(): Promise<InstrumentData[]> {
    const instruments = await prisma.instrument_lists.findMany({
        where: {
            exchange: "NSE",
            upstox_id: {
                not: null,
                startsWith: "NSE_EQ",
            },
        },
        select: {
            id: true,
            instrument_type: true,
            upstox_id: true,
        },
    });

    return instruments.map((s) => ({
        id: s.id,
        instrument_type: s.instrument_type,
        upstox_id: s.upstox_id!,
    }));
}

/**
 * Get all NSE Futures symbols with Upstox IDs
 */
async function getFuturesSymbols(): Promise<SymbolData[]> {
    const symbols = await prisma.symbols_list.findMany({
        where: {
            segment: "FUT",
            upstox_id: { not: null },
        },
        select: {
            id: true,
            instrument_id: true,
            symbol: true,
            segment: true,
            expiry_date: true,
            upstox_id: true,
            strike: true,
            option_type: true,
            expiry_month: true,
        },
    });

    return symbols.map((s) => ({
        id: s.id,
        instrument_id: s.instrument_id,
        symbol: s.symbol,
        segment: s.segment || "FUT",
        expiry_date: s.expiry_date,
        upstox_id: s.upstox_id!,
        strike: s.strike,
        option_type: s.option_type,
        expiry_month: s.expiry_month,
    }));
}

/**
 * Get all NSE Options symbols with Upstox IDs
 */
async function getOptionsSymbols(): Promise<SymbolData[]> {
    const symbols = await prisma.symbols_list.findMany({
        where: {
            segment: "OPT",
            upstox_id: { not: null },
            expiry_date: {
                gte: new Date("2026-01-08")
            },
        },
        select: {
            id: true,
            instrument_id: true,
            symbol: true,
            segment: true,
            expiry_date: true,
            upstox_id: true,
            strike: true,
            option_type: true,
            expiry_month: true,
        },
    });

    return symbols.map((s) => ({
        id: s.id,
        instrument_id: s.instrument_id,
        symbol: s.symbol,
        segment: s.segment || "OPT",
        expiry_date: s.expiry_date,
        upstox_id: s.upstox_id!,
        strike: s.strike,
        option_type: s.option_type,
        expiry_month: s.expiry_month,
    }));
}

/**
 * Backfill NSE Equity historical OHLC data
 */
async function backfillEquityOhlc(
    instruments: InstrumentData[],
    token: string,
    fromDate: string,
    toDate: string
): Promise<number> {
    let totalInserted = 0;
    let processed = 0;

    logger.info(`📊 Backfilling ${instruments.length} NSE Equity instruments from ${fromDate} to ${toDate}...`);

    for (const inst of instruments) {
        const candles = await fetchHistoricalCandles(inst.upstox_id, token, fromDate, toDate);

        if (candles.length > 0) {
            const records = candles
                .filter((c) => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0)
                .map((c) => ({
                    symbol_id: inst.id,
                    symbol: inst.id.toString(),
                    date: new Date(c.timestamp),
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume.toString(),
                    oi: c.oi.toString(),
                    exchange: "NSE",
                }));

            if (records.length > 0) {
                const result = await prisma.nse_equity.createMany({
                    data: records,
                    skipDuplicates: true,
                });
                totalInserted += result.count;
            }
        }

        processed++;
        if (processed % 100 === 0) {
            logger.info(`✅ Equity: Processed ${processed}/${instruments.length} instruments`);
        }

        await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }

    logger.info(`✅ NSE Equity backfill complete: ${totalInserted} records inserted`);
    return totalInserted;
}

/**
 * Backfill NSE Futures historical OHLC data
 */
async function backfillFuturesOhlc(
    symbols: SymbolData[],
    token: string,
    fromDate: string,
    toDate: string
): Promise<number> {
    let totalInserted = 0;
    let processed = 0;

    logger.info(`📊 Backfilling ${symbols.length} NSE Futures symbols from ${fromDate} to ${toDate}...`);

    for (const sym of symbols) {
        const candles = await fetchHistoricalCandles(sym.upstox_id, token, fromDate, toDate);

        if (candles.length > 0) {
            const records = candles
                .filter((c) => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0)
                .map((c) => ({
                    symbol_id: sym.id.toString(),
                    symbol: sym.id,
                    date: new Date(c.timestamp),
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume.toString(),
                    oi: c.oi.toString(),
                    underlying: sym.instrument_id,
                    expiry_date: sym.expiry_date,
                }));

            if (records.length > 0) {
                const result = await prisma.nse_futures.createMany({
                    data: records,
                    skipDuplicates: true,
                });
                totalInserted += result.count;
            }
        }

        processed++;
        if (processed % 100 === 0) {
            logger.info(`✅ Futures: Processed ${processed}/${symbols.length} symbols`);
        }

        await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }

    logger.info(`✅ NSE Futures backfill complete: ${totalInserted} records inserted`);
    return totalInserted;
}

/**
 * Backfill NSE Options historical OHLC data
 */
async function backfillOptionsOhlc(
    symbols: SymbolData[],
    token: string,
    fromDate: string,
    toDate: string
): Promise<number> {
    let totalInserted = 0;
    let processed = 0;

    logger.info(`📊 Backfilling ${symbols.length} NSE Options symbols from ${fromDate} to ${toDate}...`);

    for (const sym of symbols) {
        const candles = await fetchHistoricalCandles(sym.upstox_id, token, fromDate, toDate);

        if (candles.length > 0) {
            const records = candles
                .filter((c) => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0)
                .map((c) => ({
                    symbol_id: sym.id.toString(),
                    symbol: sym.id,
                    date: new Date(c.timestamp),
                    open: c.open,
                    high: c.high,
                    low: c.low,
                    close: c.close,
                    volume: c.volume.toString(),
                    oi: c.oi.toString(),
                    underlying: sym.instrument_id,
                    expiry_date: sym.expiry_date,
                    strike: sym.strike,
                    option_type: sym.option_type,
                    expiry_month: sym.expiry_month,
                }));

            if (records.length > 0) {
                const result = await prisma.nse_options.createMany({
                    data: records,
                    skipDuplicates: true,
                });
                totalInserted += result.count;
            }
        }

        processed++;
        if (processed % 500 === 0) {
            logger.info(`✅ Options: Processed ${processed}/${symbols.length} symbols`);
        }

        await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }

    logger.info(`✅ NSE Options backfill complete: ${totalInserted} records inserted`);
    return totalInserted;
}

/**
 * Main backfill function - Fetches historical OHLC data for the specified date range
 * @param fromDate Start date in YYYY-MM-DD format
 * @param toDate End date in YYYY-MM-DD format
 * @param segments Optional array of segments to backfill: ["equity", "futures", "options"]
 */
export async function backfillHistoricalOhlc(
    fromDate: string,
    toDate: string,
    segments: ("equity" | "futures" | "options")[] = ["equity", "futures", "options"]
): Promise<void> {
    const startTime = Date.now();
    logger.info(`🕐 Starting Historical OHLC Backfill from ${fromDate} to ${toDate}`);
    logger.info(`📊 Segments: ${segments.join(", ")}`);

    try {
        // 1. Get Access Token
        const token = await upstoxAuthService.getAccessToken();
        if (!token) {
            logger.error("❌ No Upstox Access Token available. Aborting backfill.");
            return;
        }

        let equityCount = 0;
        let futuresCount = 0;
        let optionsCount = 0;

        // 2. Backfill Equity
        // if (segments.includes("equity")) {
        //     const instruments = await getEquityInstruments();
        //     equityCount = await backfillEquityOhlc(instruments, token, fromDate, toDate);
        // }

        // 3. Backfill Futures
        // if (segments.includes("futures")) {
        //     const symbols = await getFuturesSymbols();
        //     futuresCount = await backfillFuturesOhlc(symbols, token, fromDate, toDate);
        // }

        // 4. Backfill Options
        if (segments.includes("options")) {
            const symbols = await getOptionsSymbols();
            optionsCount = await backfillOptionsOhlc(symbols, token, fromDate, toDate);
        }

        const totalInserted = equityCount + futuresCount + optionsCount;
        const duration = (Date.now() - startTime) / 1000;

        logger.info(`\n✅ Historical OHLC Backfill Completed!`);
        logger.info(`📊 Results:`);
        logger.info(`   - Equity: ${equityCount} records`);
        logger.info(`   - Futures: ${futuresCount} records`);
        logger.info(`   - Options: ${optionsCount} records`);
        logger.info(`   - Total: ${totalInserted} records`);
        logger.info(`⏱️ Duration: ${duration.toFixed(2)} seconds`);

    } catch (error: any) {
        logger.error("❌ Critical Error in Historical OHLC Backfill:", error.message);
    }
}

/**
 * Run backfill for the requested date range: 08 Jan 2026 to 23 Jan 2026
 */
export async function runJanuary2026Backfill(): Promise<void> {
    await backfillHistoricalOhlc("2026-01-08", "2026-01-23");
}

// If running directly as a script
if (require.main === module) {
    runJanuary2026Backfill()
        .then(() => {
            logger.info("Backfill script completed.");
            process.exit(0);
        })
        .catch((err) => {
            logger.error("Backfill script failed:", err);
            process.exit(1);
        });
}
