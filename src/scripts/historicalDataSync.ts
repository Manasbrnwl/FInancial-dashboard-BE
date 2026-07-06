import { PrismaClient } from "@prisma/client";
import axios from "axios";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { loadEnv } from "../config/env";
import { devError, devLog } from "../utils/errorLogger";

loadEnv();
const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Constants & Config
// ---------------------------------------------------------------------------
const RATE_LIMIT_DELAY_MS = 200;

const DEFAULT_START_DATES: Record<string, string> = {
    equity: "2024-01-01",
    futures: "2025-09-01",
    options: "2025-09-01",
};

type Segment = "equity" | "futures" | "options";
const ALL_SEGMENTS: Segment[] = ["equity", "futures", "options"];

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------
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

interface BackfillResult {
    segment: string;
    totalInstruments: number;
    instrumentsProcessed: number;
    instrumentsSkipped: number;
    instrumentsFailed: number;
    recordsInserted: number;
    duration: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDate(d: Date): string {
    return d.toISOString().split("T")[0];
}

function addDays(d: Date, n: number): Date {
    const result = new Date(d);
    result.setDate(result.getDate() + n);
    return result;
}

function getYesterday(): Date {
    return addDays(new Date(), -1);
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Upstox V2 Historical Candle API
// ---------------------------------------------------------------------------

async function fetchHistoricalCandles(
    instrumentKey: string,
    accessToken: string,
    fromDate: string,
    toDate: string
): Promise<HistoricalCandle[]> {
    try {
        const encodedKey = encodeURIComponent(instrumentKey);
        const url = `${UPSTOX_CONFIG.BASE_URL_V3}/historical-candle/${encodedKey}/days/1/${toDate}/${fromDate}`;

        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
            },
            timeout: 10000,
        });

        if (response.data.status === "success" && response.data.data?.candles) {
            return response.data.data.candles.map((candle: number[]) => ({
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
        if (error.response?.status !== 429) {
            devError(
                `❌ Fetch failed for ${instrumentKey}:`,
                error.response?.data?.errors || error.message
            );
        }
        return [];
    }
}

// ---------------------------------------------------------------------------
// Batch Last-Date Queries
// ---------------------------------------------------------------------------

async function getEquityLastDates(): Promise<Map<string, Date>> {
    const rows = await prisma.$queryRaw<
        Array<{ symbol: string; last_date: Date }>
    >`SELECT symbol, MAX(date) AS last_date
      FROM market_data.nse_equity
      GROUP BY symbol`;

    const map = new Map<string, Date>();
    for (const r of rows) {
        map.set(r.symbol, new Date(r.last_date));
    }
    return map;
}

// ---------------------------------------------------------------------------
// Instrument/Symbol Loaders
// ---------------------------------------------------------------------------

async function loadEquityInstruments(): Promise<InstrumentData[]> {
    const instruments = await prisma.instrument_lists.findMany({
        where: {
            exchange: "NSE",
            upstox_id: { not: null },
            OR: [
                { upstox_id: { startsWith: "NSE_EQ" } },
                { upstox_id: { startsWith: "NSE_INDEX" } }
            ]
        },
        select: { id: true, instrument_type: true, upstox_id: true },
    });

    return instruments.map((s) => ({
        id: s.id,
        instrument_type: s.instrument_type,
        upstox_id: s.upstox_id!,
    }));
}

async function loadFuturesSymbols(): Promise<SymbolData[]> {
    const symbols = await prisma.symbols_list.findMany({
        where: {
            segment: "FUT",
            upstox_id: { not: null },
            // expiry_date: { gte: new Date() },
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

async function loadOptionsSymbols(): Promise<SymbolData[]> {
    const symbols = await prisma.symbols_list.findMany({
        where: {
            segment: "OPT",
            upstox_id: { not: null },
            // expiry_date: { gte: new Date() },
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

// ---------------------------------------------------------------------------
// Segment Backfill Handlers
// ---------------------------------------------------------------------------

async function syncEquity(
    token: string,
    defaultStart: string
): Promise<BackfillResult> {
    const startTime = Date.now();
    const result: BackfillResult = {
        segment: "NSE Equity",
        totalInstruments: 0,
        instrumentsProcessed: 0,
        instrumentsSkipped: 0,
        instrumentsFailed: 0,
        recordsInserted: 0,
        duration: 0,
    };

    const instruments = await loadEquityInstruments();
    result.totalInstruments = instruments.length;
    devLog(`📊 [Equity] Loaded ${instruments.length} instruments`);

    const yesterday = getYesterday();
    const toDate = formatDate(yesterday);

    for (let i = 0; i < instruments.length; i++) {
        const inst = instruments[i];
        const symbolKey = inst.id.toString();

        try {
            const lastRecord = await prisma.nse_equity.findFirst({
                where: { symbol: symbolKey },
                orderBy: { date: "desc" },
                select: { date: true }
            });
            const lastDate = lastRecord?.date;
            const fromDateObj = lastDate ? addDays(lastDate, 1) : new Date(defaultStart);
            const fromDate = formatDate(fromDateObj);

            if (fromDateObj > yesterday) {
                result.instrumentsSkipped++;
                continue;
            }

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
                    let attempts = 0;
                    while (attempts < 3) {
                        try {
                            const res = await prisma.nse_equity.createMany({
                                data: records,
                                skipDuplicates: true,
                            });
                            result.recordsInserted += res.count;
                            break;
                        } catch (err: any) {
                            attempts++;
                            if (attempts === 3) throw err;
                            devError(`⚠️ [Equity] Prisma insert failed (attempt ${attempts}/3), retrying in 2s...`, err.message);
                            await delay(2000);
                            await prisma.$connect().catch(() => {});
                        }
                    }
                }
            }

            result.instrumentsProcessed++;
        } catch (error: any) {
            result.instrumentsFailed++;
            devError(`❌ [Equity] Failed ${inst.instrument_type} (${inst.upstox_id}): ${error.message}`);
        }

        if ((i + 1) % 100 === 0) {
            devLog(`✅ [Equity] Progress: ${i + 1}/${instruments.length} | Inserted: ${result.recordsInserted}`);
        }

        await delay(RATE_LIMIT_DELAY_MS);
    }

    result.duration = (Date.now() - startTime) / 1000;
    return result;
}

async function syncFutures(
    token: string,
    defaultStart: string
): Promise<BackfillResult> {
    const startTime = Date.now();
    const result: BackfillResult = {
        segment: "NSE Futures",
        totalInstruments: 0,
        instrumentsProcessed: 0,
        instrumentsSkipped: 0,
        instrumentsFailed: 0,
        recordsInserted: 0,
        duration: 0,
    };

    const symbols = await loadFuturesSymbols();
    result.totalInstruments = symbols.length;
    devLog(`📊 [Futures] Loaded ${symbols.length} symbols`);

    const yesterday = getYesterday();
    const toDate = formatDate(yesterday);

    for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];

        try {
            // symbols_list.symbol (Int) is the FK stored on nse_futures.symbol — see backfill inserts.
            const lastRecord = await prisma.nse_futures.findFirst({
                where: { symbol: sym.id },
                orderBy: { date: "desc" },
                select: { date: true }
            });
            const lastDate = lastRecord?.date;
            const fromDateObj = lastDate ? addDays(lastDate, 1) : new Date(defaultStart);
            const fromDate = formatDate(fromDateObj);

            if (fromDateObj > yesterday) {
                result.instrumentsSkipped++;
                continue;
            }

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
                    let attempts = 0;
                    while (attempts < 3) {
                        try {
                            const res = await prisma.nse_futures.createMany({
                                data: records,
                                skipDuplicates: true,
                            });
                            result.recordsInserted += res.count;
                            break;
                        } catch (err: any) {
                            attempts++;
                            if (attempts === 3) throw err;
                            devError(`⚠️ [Futures] Prisma insert failed (attempt ${attempts}/3), retrying in 2s...`, err.message);
                            await delay(2000);
                            await prisma.$connect().catch(() => {});
                        }
                    }
                }
            }

            result.instrumentsProcessed++;
        } catch (error: any) {
            result.instrumentsFailed++;
            devError(`❌ [Futures] Failed ${sym.symbol} (${sym.upstox_id}): ${error.message}`);
        }

        if ((i + 1) % 100 === 0) {
            devLog(`✅ [Futures] Progress: ${i + 1}/${symbols.length} | Inserted: ${result.recordsInserted}`);
        }

        await delay(RATE_LIMIT_DELAY_MS);
    }

    result.duration = (Date.now() - startTime) / 1000;
    return result;
}

async function syncOptions(
    token: string,
    defaultStart: string
): Promise<BackfillResult> {
    const startTime = Date.now();
    const result: BackfillResult = {
        segment: "NSE Options",
        totalInstruments: 0,
        instrumentsProcessed: 0,
        instrumentsSkipped: 0,
        instrumentsFailed: 0,
        recordsInserted: 0,
        duration: 0,
    };

    const symbols = await loadOptionsSymbols();
    result.totalInstruments = symbols.length;
    devLog(`📊 [Options] Loaded ${symbols.length} symbols`);

    const yesterday = getYesterday();
    const toDate = formatDate(yesterday);

    for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];

        try {
            // symbols_list.symbol (Int) is the FK stored on nse_options.symbol — see backfill inserts.
            const lastRecord = await prisma.nse_options.findFirst({
                where: { symbol: sym.id },
                orderBy: { date: "desc" },
                select: { date: true }
            });
            const lastDate = lastRecord?.date;
            const fromDateObj = lastDate ? addDays(lastDate, 1) : new Date(defaultStart);
            const fromDate = formatDate(fromDateObj);

            if (fromDateObj > yesterday) {
                result.instrumentsSkipped++;
                continue;
            }

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
                    let attempts = 0;
                    while (attempts < 3) {
                        try {
                            const res = await prisma.nse_options.createMany({
                                data: records,
                                skipDuplicates: true,
                            });
                            result.recordsInserted += res.count;
                            break;
                        } catch (err: any) {
                            attempts++;
                            if (attempts === 3) throw err;
                            devError(`⚠️ [Options] Prisma insert failed (attempt ${attempts}/3), retrying in 2s...`, err.message);
                            await delay(2000);
                            await prisma.$connect().catch(() => {});
                        }
                    }
                }
            }

            result.instrumentsProcessed++;
        } catch (error: any) {
            result.instrumentsFailed++;
            devError(`❌ [Options] Failed ${sym.symbol} (${sym.upstox_id}): ${error.message}`);
        }

        if ((i + 1) % 100 === 0) {
            devLog(`✅ [Options] Progress: ${i + 1}/${symbols.length} | Inserted: ${result.recordsInserted}`);
        }

        await delay(RATE_LIMIT_DELAY_MS);
    }

    result.duration = (Date.now() - startTime) / 1000;
    return result;
}

// ---------------------------------------------------------------------------
// CLI Arg Parsing
// ---------------------------------------------------------------------------

function parseArgs(): { segments: Segment[]; defaultStart: string } {
    const args = process.argv.slice(2);
    let segments: Segment[] = [...ALL_SEGMENTS];
    let defaultStart = "";

    for (let i = 0; i < args.length; i++) {
        if (args[i] === "--segments" && args[i + 1]) {
            const raw = args[i + 1].split(",").map((s) => s.trim().toLowerCase());
            segments = raw.filter((s): s is Segment => ALL_SEGMENTS.includes(s as Segment));
            i++;
        }
        if (args[i] === "--default-start" && args[i + 1]) {
            defaultStart = args[i + 1];
            i++;
        }
    }

    return { segments, defaultStart };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const { segments, defaultStart: globalDefault } = parseArgs();

    devLog(`\n${"=".repeat(60)}`);
    devLog(`🚀 Historical Data Sync — ${new Date().toISOString()}`);
    devLog(`📊 Segments: ${segments.join(", ")}`);
    devLog(`${"=".repeat(60)}\n`);

    // 1. Auth
    const token = await upstoxAuthService.getAccessToken();
    if (!token) {
        devError("❌ No Upstox Access Token. Run auth flow first. Aborting.");
        process.exit(1);
    }
    devLog("✅ Upstox token acquired\n");

    const results: BackfillResult[] = [];

    // 2. Run each segment
    if (segments.includes("equity")) {
        devLog(`\n${"—".repeat(40)}`);
        devLog("📈 Starting NSE Equity sync...");
        devLog(`${"—".repeat(40)}`);
        const r = await syncEquity(token, globalDefault || DEFAULT_START_DATES.equity);
        results.push(r);
        logResult(r);
    }

    if (segments.includes("futures")) {
        devLog(`\n${"—".repeat(40)}`);
        devLog("📈 Starting NSE Futures sync...");
        devLog(`${"—".repeat(40)}`);
        const r = await syncFutures(token, globalDefault || DEFAULT_START_DATES.futures);
        results.push(r);
        logResult(r);
    }

    if (segments.includes("options")) {
        devLog(`\n${"—".repeat(40)}`);
        devLog("📈 Starting NSE Options sync...");
        devLog(`${"—".repeat(40)}`);
        const r = await syncOptions(token, globalDefault || DEFAULT_START_DATES.options);
        results.push(r);
        logResult(r);
    }

    // 3. Final summary
    devLog(`\n${"=".repeat(60)}`);
    devLog("✅ SYNC COMPLETE — FINAL SUMMARY");
    devLog(`${"=".repeat(60)}`);

    let totalRecords = 0;
    let totalDuration = 0;

    for (const r of results) {
        totalRecords += r.recordsInserted;
        totalDuration += r.duration;
        devLog(
            `  ${r.segment.padEnd(15)} | Total: ${r.totalInstruments} | Processed: ${r.instrumentsProcessed} | Skipped: ${r.instrumentsSkipped} | Failed: ${r.instrumentsFailed} | Inserted: ${r.recordsInserted} | ${r.duration.toFixed(1)}s`
        );
    }

    devLog(`${"—".repeat(60)}`);
    devLog(`  Total records inserted: ${totalRecords}`);
    devLog(`  Total duration: ${totalDuration.toFixed(1)}s (${(totalDuration / 60).toFixed(1)} min)`);
    devLog(`${"=".repeat(60)}\n`);
}

function logResult(r: BackfillResult): void {
    devLog(`\n✅ ${r.segment} complete:`);
    devLog(`   Total: ${r.totalInstruments} | Processed: ${r.instrumentsProcessed} | Skipped: ${r.instrumentsSkipped} | Failed: ${r.instrumentsFailed}`);
    devLog(`   Records inserted: ${r.recordsInserted} | Duration: ${r.duration.toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

if (require.main === module) {
    main()
        .then(() => {
            prisma.$disconnect();
            process.exit(0);
        })
        .catch((err) => {
            devError("❌ Script crashed:", err);
            prisma.$disconnect();
            process.exit(1);
        });
}

export { main as runHistoricalDataSync };
