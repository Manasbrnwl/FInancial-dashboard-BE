import dotenv from "dotenv";
import path from "path";
import axios from "axios";
import { PrismaClient } from "@prisma/client";

dotenv.config({ path: path.resolve(__dirname, "../.env") });
const prisma = new PrismaClient();

// ─── Config ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SEGMENT_ARG = args.find(a => a.startsWith("--segment="))?.split("=")[1]?.toLowerCase() ?? "all";
const RUN_EQ  = SEGMENT_ARG === "all" || SEGMENT_ARG === "eq";
const RUN_FUT = SEGMENT_ARG === "all" || SEGMENT_ARG === "fut";
const RUN_OPT = SEGMENT_ARG === "all" || SEGMENT_ARG === "opt";

const CANDLE_INTERVAL = "1minute";
const START_DATE = "2025-07-01";
const TODAY = new Date().toISOString().split("T")[0];
const UPSTOX_BASE = "https://api.upstox.com";

// Concurrency: 10 parallel requests, batch every 9s → 10/9 = 1.11 req/sec (Upstox limit)
const CONCURRENCY = 10;
const BATCH_DELAY_MS = 9200;

// ─── Types ────────────────────────────────────────────────────────────────────

// Upstox V2 candle: [timestamp, open, high, low, close, volume, oi]
type UpstoxCandle = [string, number, number, number, number, number, number];

interface TickRow {
    instrumentId: number;
    ltp: string;
    volume: string;
    oi: string;
    time: Date;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/** Generate YYYY-MM month strings between two dates */
function monthsBetween(from: string, to: string): string[] {
    const months: string[] = [];
    const start = new Date(from);
    const end = new Date(to);
    const cursor = new Date(start.getFullYear(), start.getMonth(), 1);
    while (cursor <= end) {
        months.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
        cursor.setMonth(cursor.getMonth() + 1);
    }
    return months;
}

/** First and last day of a YYYY-MM month string, clamped to backfill window */
function monthWindow(ym: string): { from: string; to: string } {
    const [y, m] = ym.split("-").map(Number);
    const first = `${ym}-01`;
    const last = new Date(y, m, 0).toISOString().split("T")[0]; // last day of month
    return {
        from: first < START_DATE ? START_DATE : first,
        to: last > TODAY ? TODAY : last,
    };
}

async function fetchCandles(
    instrumentKey: string,
    from: string,
    to: string,
    token: string,
    expired: boolean,
): Promise<UpstoxCandle[]> {
    const encoded = encodeURIComponent(instrumentKey);
    const base = expired
        ? `${UPSTOX_BASE}/v2/expired-instruments/historical-candle`
        : `${UPSTOX_BASE}/v2/historical-candle`;
    const url = `${base}/${encoded}/${CANDLE_INTERVAL}/${to}/${from}`;
    const res = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 30000,
    });
    return res.data?.data?.candles ?? [];
}

function candlesToTicks(candles: UpstoxCandle[], instrumentId: number): TickRow[] {
    return candles.map(c => ({
        instrumentId,
        ltp: String(c[4]),     // close → ltp
        volume: String(c[5]),
        oi: String(c[6]),
        time: new Date(c[0]),
    }));
}

async function upsertTicks(
    table: "ticksDataNSEEQ" | "ticksDataNSEFUT" | "ticksDataNSEOPT",
    rows: TickRow[],
): Promise<void> {
    if (rows.length === 0) return;
    const schema = "periodic_market_data";
    const CHUNK = 500;

    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values: (string | number | Date)[] = [];
        const placeholders = chunk.map((row, idx) => {
            const b = idx * 4;
            values.push(row.instrumentId, row.ltp, row.volume, row.oi, row.time);
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},NOW(),NOW())`;
        });

        // Fix placeholder count: 5 params per row
        const fixedPlaceholders = chunk.map((row, idx) => {
            const b = idx * 5;
            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},NOW(),NOW())`;
        });

        const sql = `
            INSERT INTO ${schema}."${table}"
              ("instrumentId", ltp, volume, oi, time, "createdAt", "updatedAt")
            VALUES ${fixedPlaceholders.join(",")}
            ON CONFLICT ("instrumentId", time)
            DO UPDATE SET
              ltp       = EXCLUDED.ltp,
              volume    = EXCLUDED.volume,
              oi        = EXCLUDED.oi,
              "updatedAt" = NOW()
        `;
        await prisma.$executeRawUnsafe(sql, ...values);
    }
}

/**
 * Load all already-populated (instrumentId, YYYY-MM) combos in ONE query.
 * Returns a Set of "instrumentId_YYYY-MM" strings for O(1) lookup.
 */
async function loadDoneSet(
    table: "ticksDataNSEEQ" | "ticksDataNSEFUT" | "ticksDataNSEOPT",
): Promise<Set<string>> {
    const schema = "periodic_market_data";
    const rows: Array<{ instrumentId: number; ym: string }> = await prisma.$queryRawUnsafe(`
        SELECT "instrumentId",
               to_char(date_trunc('month', time), 'YYYY-MM') AS ym
        FROM ${schema}."${table}"
        WHERE time >= '${START_DATE}'
        GROUP BY "instrumentId", ym
        HAVING count(*) > 70
    `);
    const done = new Set<string>();
    for (const r of rows) done.add(`${r.instrumentId}_${r.ym}`);
    console.log(`  📦 Loaded ${done.size} already-completed (instrument, month) combos.`);
    return done;
}

/**
 * Run a list of async tasks with a concurrency cap.
 * Fires tasks in batches of CONCURRENCY, sleeps BATCH_DELAY_MS between batches.
 */
async function runBatched<T>(tasks: Array<() => Promise<T>>): Promise<void> {
    for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map(t => t()));
        if (i + CONCURRENCY < tasks.length) await sleep(BATCH_DELAY_MS);
    }
}

// ─── Phase 1: EQ ─────────────────────────────────────────────────────────────

async function backfillEQ(token: string): Promise<void> {
    console.log("\n📊 Phase 1: EQ");

    const instruments = await prisma.instrument_lists.findMany({
        where: { exchange: "NSE", upstox_id: { not: null } },
        select: { id: true, instrument_type: true, upstox_id: true },
    });
    console.log(`  ${instruments.length} instruments`);

    const done = await loadDoneSet("ticksDataNSEEQ");
    const allMonths = monthsBetween(START_DATE, TODAY);

    let processed = 0, skipped = 0, errors = 0;

    const tasks: Array<() => Promise<void>> = [];

    for (const inst of instruments) {
        const key = `NSE_EQ|${inst.upstox_id!.replace(/^NSE_EQ\|/, "")}`;
        for (const ym of allMonths) {
            if (done.has(`${inst.id}_${ym}`)) { skipped++; continue; }
            const { from, to } = monthWindow(ym);
            tasks.push(async () => {
                try {
                    const candles = await fetchCandles(key, from, to, token, false);
                    if (candles.length === 0) return;
                    const rows = candlesToTicks(candles, inst.id);
                    if (!DRY_RUN) await upsertTicks("ticksDataNSEEQ", rows);
                    processed += rows.length;
                    process.stdout.write(`\r  EQ ${inst.instrument_type} ${ym} → ${rows.length} ticks (total: ${processed})`);
                } catch (err: any) {
                    if (err.response?.status !== 404) {
                        errors++;
                        process.stdout.write(`\n  ❌ EQ ${inst.instrument_type} ${ym}: ${err.response?.data?.errors?.[0]?.message ?? err.message}\n`);
                    }
                }
            });
        }
    }

    console.log(`\n  Tasks: ${tasks.length}, skipped: ${skipped}`);
    await runBatched(tasks);
    console.log(`\n  ✅ EQ done — ticks: ${processed}, errors: ${errors}`);
}

// ─── Phase 2: FUT ────────────────────────────────────────────────────────────

async function backfillFUT(token: string): Promise<void> {
    console.log("\n📈 Phase 2: FUT");

    const symbols = await prisma.symbols_list.findMany({
        where: { segment: "FUT", upstox_id: { not: null }, expiry_date: { gte: new Date(START_DATE) } },
        select: { id: true, symbol: true, upstox_id: true, expiry_date: true },
        orderBy: { expiry_date: "asc" },
    });
    console.log(`  ${symbols.length} FUT symbols`);

    const done = await loadDoneSet("ticksDataNSEFUT");
    const now = new Date();
    let processed = 0, skipped = 0, errors = 0;
    const tasks: Array<() => Promise<void>> = [];

    for (const sym of symbols) {
        if (!sym.upstox_id || !sym.expiry_date) continue;
        const expired = sym.expiry_date < now;
        const windowEnd = expired ? sym.expiry_date.toISOString().split("T")[0] : TODAY;
        const months = monthsBetween(START_DATE, windowEnd);

        for (const ym of months) {
            if (done.has(`${sym.id}_${ym}`)) { skipped++; continue; }
            const { from, to } = monthWindow(ym);
            tasks.push(async () => {
                try {
                    const candles = await fetchCandles(sym.upstox_id!, from, to, token, expired);
                    if (candles.length === 0) return;
                    const rows = candlesToTicks(candles, sym.id);
                    if (!DRY_RUN) await upsertTicks("ticksDataNSEFUT", rows);
                    processed += rows.length;
                    process.stdout.write(`\r  FUT ${sym.symbol} ${ym} → ${rows.length} ticks (total: ${processed})`);
                } catch (err: any) {
                    if (err.response?.status !== 404) {
                        errors++;
                        process.stdout.write(`\n  ❌ FUT ${sym.symbol} ${ym}: ${err.response?.data?.errors?.[0]?.message ?? err.message}\n`);
                    }
                }
            });
        }
    }

    console.log(`\n  Tasks: ${tasks.length}, skipped: ${skipped}`);
    await runBatched(tasks);
    console.log(`\n  ✅ FUT done — ticks: ${processed}, errors: ${errors}`);
}

// ─── Phase 3: OPT ────────────────────────────────────────────────────────────

async function backfillOPT(token: string): Promise<void> {
    console.log("\n📉 Phase 3: OPT");

    const symbols = await prisma.symbols_list.findMany({
        where: { segment: "OPT", upstox_id: { not: null }, expiry_date: { gte: new Date(START_DATE) } },
        select: { id: true, symbol: true, upstox_id: true, expiry_date: true },
        orderBy: { expiry_date: "asc" },
    });
    console.log(`  ${symbols.length} OPT symbols`);

    const done = await loadDoneSet("ticksDataNSEOPT");
    const now = new Date();
    let processed = 0, skipped = 0, errors = 0;
    const tasks: Array<() => Promise<void>> = [];

    for (const sym of symbols) {
        if (!sym.upstox_id || !sym.expiry_date) continue;
        const expired = sym.expiry_date < now;
        const windowEnd = expired ? sym.expiry_date.toISOString().split("T")[0] : TODAY;
        const months = monthsBetween(START_DATE, windowEnd);

        for (const ym of months) {
            if (done.has(`${sym.id}_${ym}`)) { skipped++; continue; }
            const { from, to } = monthWindow(ym);
            tasks.push(async () => {
                try {
                    const candles = await fetchCandles(sym.upstox_id!, from, to, token, expired);
                    if (candles.length === 0) return;
                    const rows = candlesToTicks(candles, sym.id);
                    if (!DRY_RUN) await upsertTicks("ticksDataNSEOPT", rows);
                    processed += rows.length;
                    process.stdout.write(`\r  OPT ${sym.symbol} ${ym} → ${rows.length} ticks (total: ${processed})`);
                } catch (err: any) {
                    if (err.response?.status !== 404) {
                        errors++;
                        process.stdout.write(`\n  ❌ OPT ${sym.symbol} ${ym}: ${err.response?.data?.errors?.[0]?.message ?? err.message}\n`);
                    }
                }
            });
        }
    }

    console.log(`\n  Tasks: ${tasks.length}, skipped: ${skipped}`);
    await runBatched(tasks);
    console.log(`\n  ✅ OPT done — ticks: ${processed}, errors: ${errors}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    console.log(`🚀 Ticks Backfill  DRY_RUN=${DRY_RUN}  SEGMENT=${SEGMENT_ARG}`);
    console.log(`📅 ${START_DATE} → ${TODAY}  |  concurrency=${CONCURRENCY}  batchDelay=${BATCH_DELAY_MS}ms\n`);

    const config = await prisma.app_config.findUnique({ where: { key: "UPSTOX_ACCESS_TOKEN" } });
    if (!config?.value) {
        console.error("❌ No UPSTOX_ACCESS_TOKEN in app_config. Re-authenticate via the app.");
        process.exit(1);
    }
    console.log("✅ Token loaded.");

    const token = config.value;
    if (RUN_EQ)  await backfillEQ(token);
    if (RUN_FUT) await backfillFUT(token);
    if (RUN_OPT) await backfillOPT(token);

    await prisma.$disconnect();
    console.log("\n🏁 Done.");
}

run().catch(async e => {
    console.error("💥", e);
    await prisma.$disconnect();
    process.exit(1);
});
