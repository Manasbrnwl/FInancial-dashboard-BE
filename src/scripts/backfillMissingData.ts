import axios from "axios";
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { loadEnv } from "../config/env";

loadEnv();

/**
 * Backfill missing daily OHLC and 5-minute tick data after 1 Dec 2025.
 *
 * For every NSE equity/index instrument (instrument_lists) and every FUT/OPT
 * contract (symbols_list, expiry_date >= 1 Dec 2025), finds trading days with
 * no row in nse_equity / nse_futures / nse_options / ticksDataNSEEQ /
 * ticksDataNSEFUT / ticksDataNSEOPT and fills them from the Upstox
 * historical-candle API (interval "day" for OHLC tables, "minutes/5" for ticks).
 *
 * The trading-day calendar is the set of distinct dates present in nse_equity.
 * Per instrument/contract, the checked window starts at its first existing row
 * (or created_at for rows with no data yet) so days before a contract listed
 * are not treated as missing, and ends at min(today, expiry_date).
 *
 * Usage:
 *   npx ts-node src/scripts/backfillMissingData.ts [--dry-run] [--segments daily-eq,ticks-fut,...]
 * Segments: daily-eq, daily-fut, daily-opt, ticks-eq, ticks-fut, ticks-opt (default: all)
 */

const START = "2025-12-01";
const RATE_LIMIT_DELAY_MS = 200;
const IST_OFFSET_MS = 19800000; // ticks jobs store IST wall-clock time (+5:30) — keep the same convention

const ALL_SEGMENTS = ["daily-eq", "daily-fut", "daily-opt", "ticks-eq", "ticks-fut", "ticks-opt"] as const;
type Segment = (typeof ALL_SEGMENTS)[number];

interface Candle {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    oi: number;
}

interface MissingInstrument {
    id: number;
    name: string;
    upstox_id: string;
    missing_dates: Date[];
}

interface MissingSymbol {
    id: number;
    symbol: string;
    upstox_id: string;
    instrument_id: number;
    expiry_date: Date;
    strike: string | null;
    option_type: string | null;
    expiry_month: string | null;
    missing_dates: Date[];
}

function fmt(d: Date): string {
    return d.toISOString().split("T")[0];
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function fetchCandles(url: string, token: string): Promise<Candle[]> {
    try {
        const response = await axios.get(url, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
            timeout: 15000,
        });
        if (response.data.status === "success" && response.data.data?.candles) {
            // API returns: [timestamp, open, high, low, close, volume, oi]
            return response.data.data.candles.map((c: any[]) => ({
                timestamp: c[0],
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                volume: c[5],
                oi: c[6] || 0,
            }));
        }
        return [];
    } catch (error: any) {
        if (error.response?.status !== 429) {
            console.error(`  ❌ Upstox fetch failed: ${url} — ${error.response?.data?.errors?.[0]?.message || error.message}`);
        }
        return [];
    }
}

function dailyUrl(upstoxId: string, from: string, to: string): string {
    return `${UPSTOX_CONFIG.BASE_URL_V3}/historical-candle/${encodeURIComponent(upstoxId)}/days/1/${to}/${from}`;
}

function intradayUrl(upstoxId: string, from: string, to: string): string {
    return `${UPSTOX_CONFIG.BASE_URL_V3}/historical-candle/${encodeURIComponent(upstoxId)}/minutes/5/${to}/${from}`;
}

async function insertChunked(data: any[], insert: (chunk: any[]) => Promise<{ count: number }>): Promise<number> {
    let inserted = 0;
    for (let i = 0; i < data.length; i += 1000) {
        const res = await insert(data.slice(i, i + 1000));
        inserted += res.count;
    }
    return inserted;
}

// ---------------------------------------------------------------------------
// Missing-day queries. Calendar = distinct trading dates in nse_equity.
// ---------------------------------------------------------------------------

async function findMissingDailyEquity(): Promise<MissingInstrument[]> {
    return prisma.$queryRaw<MissingInstrument[]>`
        WITH cal AS (
            SELECT DISTINCT date AS d FROM market_data.nse_equity WHERE date >= ${START}::date
        ),
        have AS (
            SELECT symbol_id AS iid, date FROM market_data.nse_equity
            WHERE date >= ${START}::date AND symbol_id IS NOT NULL
        ),
        bounds AS (SELECT iid, MIN(date) AS first_date FROM have GROUP BY iid)
        SELECT il.id, il.instrument_type AS name, il.upstox_id,
               array_agg(c.d ORDER BY c.d) AS missing_dates
        FROM market_data.instrument_lists il
        LEFT JOIN bounds b ON b.iid = il.id
        JOIN cal c ON c.d >= GREATEST(${START}::date, COALESCE(b.first_date, il.created_at::date, ${START}::date))
        LEFT JOIN have h ON h.iid = il.id AND h.date = c.d
        WHERE il.upstox_id IS NOT NULL
          AND (il.upstox_id LIKE 'NSE_EQ%' OR il.upstox_id LIKE 'NSE_INDEX%')
          AND h.iid IS NULL
        GROUP BY il.id, il.instrument_type, il.upstox_id
        ORDER BY il.instrument_type
    `;
}

async function findMissingDailySymbols(segment: "FUT" | "OPT"): Promise<MissingSymbol[]> {
    const table = Prisma.raw(segment === "FUT" ? "market_data.nse_futures" : "market_data.nse_options");
    return prisma.$queryRaw<MissingSymbol[]>`
        WITH cal AS (
            SELECT DISTINCT date AS d FROM market_data.nse_equity WHERE date >= ${START}::date
        ),
        have AS (
            SELECT symbol AS sid, date FROM ${table} WHERE date >= ${START}::date
        ),
        bounds AS (SELECT sid, MIN(date) AS first_date FROM have GROUP BY sid)
        SELECT sl.id, sl.symbol, sl.upstox_id, sl.instrument_id, sl.expiry_date,
               sl.strike, sl.option_type, sl.expiry_month,
               array_agg(c.d ORDER BY c.d) AS missing_dates
        FROM market_data.symbols_list sl
        LEFT JOIN bounds b ON b.sid = sl.id
        JOIN cal c
          ON c.d >= GREATEST(${START}::date, COALESCE(b.first_date, sl.created_at::date, ${START}::date))
         AND c.d <= LEAST(CURRENT_DATE, sl.expiry_date)
        LEFT JOIN have h ON h.sid = sl.id AND h.date = c.d
        WHERE sl.segment = ${segment}
          AND sl.upstox_id IS NOT NULL
          AND sl.expiry_date >= ${START}::date
          AND h.sid IS NULL
        GROUP BY sl.id, sl.symbol, sl.upstox_id, sl.instrument_id, sl.expiry_date,
                 sl.strike, sl.option_type, sl.expiry_month
        ORDER BY sl.symbol
    `;
}

async function findMissingTicksEquity(): Promise<MissingInstrument[]> {
    return prisma.$queryRaw<MissingInstrument[]>`
        WITH cal AS (
            SELECT DISTINCT date AS d FROM market_data.nse_equity WHERE date >= ${START}::date
        ),
        have AS (
            SELECT "instrumentId" AS iid, date(time) AS date
            FROM periodic_market_data."ticksDataNSEEQ"
            WHERE time >= ${START}::timestamp
            GROUP BY 1, 2
        ),
        bounds AS (SELECT iid, MIN(date) AS first_date FROM have GROUP BY iid)
        SELECT il.id, il.instrument_type AS name, il.upstox_id,
               array_agg(c.d ORDER BY c.d) AS missing_dates
        FROM market_data.instrument_lists il
        LEFT JOIN bounds b ON b.iid = il.id
        JOIN cal c ON c.d >= GREATEST(${START}::date, COALESCE(b.first_date, il.created_at::date, ${START}::date))
        LEFT JOIN have h ON h.iid = il.id AND h.date = c.d
        WHERE il.upstox_id IS NOT NULL
          AND (il.upstox_id LIKE 'NSE_EQ%' OR il.upstox_id LIKE 'NSE_INDEX%')
          AND h.iid IS NULL
        GROUP BY il.id, il.instrument_type, il.upstox_id
        ORDER BY il.instrument_type
    `;
}

async function findMissingTicksSymbols(segment: "FUT" | "OPT"): Promise<MissingSymbol[]> {
    const table = Prisma.raw(segment === "FUT" ? 'periodic_market_data."ticksDataNSEFUT"' : 'periodic_market_data."ticksDataNSEOPT"');
    return prisma.$queryRaw<MissingSymbol[]>`
        WITH cal AS (
            SELECT DISTINCT date AS d FROM market_data.nse_equity WHERE date >= ${START}::date
        ),
        have AS (
            SELECT "instrumentId" AS sid, date(time) AS date
            FROM ${table}
            WHERE time >= ${START}::timestamp
            GROUP BY 1, 2
        ),
        bounds AS (SELECT sid, MIN(date) AS first_date FROM have GROUP BY sid)
        SELECT sl.id, sl.symbol, sl.upstox_id, sl.instrument_id, sl.expiry_date,
               sl.strike, sl.option_type, sl.expiry_month,
               array_agg(c.d ORDER BY c.d) AS missing_dates
        FROM market_data.symbols_list sl
        LEFT JOIN bounds b ON b.sid = sl.id
        JOIN cal c
          ON c.d >= GREATEST(${START}::date, COALESCE(b.first_date, sl.created_at::date, ${START}::date))
         AND c.d <= LEAST(CURRENT_DATE, sl.expiry_date)
        LEFT JOIN have h ON h.sid = sl.id AND h.date = c.d
        WHERE sl.segment = ${segment}
          AND sl.upstox_id IS NOT NULL
          AND sl.expiry_date >= ${START}::date
          AND h.sid IS NULL
        GROUP BY sl.id, sl.symbol, sl.upstox_id, sl.instrument_id, sl.expiry_date,
                 sl.strike, sl.option_type, sl.expiry_month
        ORDER BY sl.symbol
    `;
}

// ---------------------------------------------------------------------------
// Fillers
// ---------------------------------------------------------------------------

async function fillDailyEquity(rows: MissingInstrument[], token: string): Promise<number> {
    let inserted = 0;
    let processed = 0;
    for (const inst of rows) {
        const from = fmt(inst.missing_dates[0]);
        const to = fmt(inst.missing_dates[inst.missing_dates.length - 1]);
        const candles = await fetchCandles(dailyUrl(inst.upstox_id, from, to), token);
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
            inserted += await insertChunked(records, (chunk) =>
                prisma.nse_equity.createMany({ data: chunk, skipDuplicates: true })
            );
        }
        processed++;
        if (processed % 100 === 0) console.log(`  ✅ daily-eq: ${processed}/${rows.length} instruments`);
        await sleep(RATE_LIMIT_DELAY_MS);
    }
    return inserted;
}

async function fillDailySymbols(rows: MissingSymbol[], segment: "FUT" | "OPT", token: string): Promise<number> {
    let inserted = 0;
    let processed = 0;
    for (const sym of rows) {
        const from = fmt(sym.missing_dates[0]);
        const to = fmt(sym.missing_dates[sym.missing_dates.length - 1]);
        const candles = await fetchCandles(dailyUrl(sym.upstox_id, from, to), token);
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
                ...(segment === "OPT"
                    ? { strike: sym.strike, option_type: sym.option_type, expiry_month: sym.expiry_month }
                    : {}),
            }));
        if (records.length > 0) {
            inserted += await insertChunked(records, (chunk) =>
                segment === "FUT"
                    ? prisma.nse_futures.createMany({ data: chunk, skipDuplicates: true })
                    : prisma.nse_options.createMany({ data: chunk, skipDuplicates: true })
            );
        }
        processed++;
        if (processed % 100 === 0) console.log(`  ✅ daily-${segment.toLowerCase()}: ${processed}/${rows.length} contracts`);
        await sleep(RATE_LIMIT_DELAY_MS);
    }
    return inserted;
}

/**
 * Fill a ticks table from 5-minute candles. Unlike the daily tables, existing
 * days hold live-quote rows at arbitrary times, so skipDuplicates would not
 * protect them — only candles falling on the missing dates are inserted.
 */
async function fillTicks(
    rows: Array<{ id: number; upstox_id: string; missing_dates: Date[] }>,
    label: string,
    withTimeBucket: boolean,
    insert: (chunk: any[]) => Promise<{ count: number }>,
    token: string
): Promise<number> {
    let inserted = 0;
    let processed = 0;
    for (const row of rows) {
        const missingSet = new Set(row.missing_dates.map(fmt));

        // V3 minutes interval allows ~1 month per request — group missing dates by month
        const byMonth = new Map<string, Date[]>();
        for (const d of row.missing_dates) {
            const key = fmt(d).slice(0, 7);
            const list = byMonth.get(key) || [];
            list.push(d);
            byMonth.set(key, list);
        }

        const records: any[] = [];
        const now = new Date();
        for (const dates of byMonth.values()) {
            const from = fmt(dates[0]);
            const to = fmt(dates[dates.length - 1]);
            const candles = await fetchCandles(intradayUrl(row.upstox_id, from, to), token);
            for (const c of candles) {
                const time = new Date(new Date(c.timestamp).getTime() + IST_OFFSET_MS);
                if (!missingSet.has(fmt(time))) continue;
                const record: any = {
                    instrumentId: row.id,
                    ltp: c.close.toString(),
                    volume: c.volume.toString(),
                    oi: c.oi.toString(),
                    time,
                    updatedAt: now,
                };
                if (withTimeBucket) {
                    const bucket = new Date(time);
                    bucket.setUTCSeconds(0, 0);
                    bucket.setUTCMinutes(Math.floor(bucket.getUTCMinutes() / 5) * 5);
                    record.time_bucket = bucket;
                }
                records.push(record);
            }
            await sleep(RATE_LIMIT_DELAY_MS);
        }

        if (records.length > 0) {
            inserted += await insertChunked(records, insert);
        }
        processed++;
        if (processed % 100 === 0) console.log(`  ✅ ${label}: ${processed}/${rows.length} processed`);
    }
    return inserted;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function report(label: string, rows: Array<{ missing_dates: Date[] }>): void {
    const totalDays = rows.reduce((sum, r) => sum + r.missing_dates.length, 0);
    console.log(`\n📊 ${label}: ${rows.length} instruments/contracts with missing days (${totalDays} day-slots)`);
    for (const r of rows.slice(0, 10) as any[]) {
        const name = r.name || r.symbol;
        console.log(`   - ${name}: ${r.missing_dates.length} days (${fmt(r.missing_dates[0])} → ${fmt(r.missing_dates[r.missing_dates.length - 1])})`);
    }
    if (rows.length > 10) console.log(`   ... and ${rows.length - 10} more`);
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    let segments: Segment[] = [...ALL_SEGMENTS];
    const segIdx = args.indexOf("--segments");
    if (segIdx !== -1 && args[segIdx + 1]) {
        segments = args[segIdx + 1]
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is Segment => (ALL_SEGMENTS as readonly string[]).includes(s));
    }

    console.log(`🚀 Missing-data backfill after ${START} (dry-run: ${dryRun})`);
    console.log(`📊 Segments: ${segments.join(", ")}`);

    let token = "";
    if (!dryRun) {
        token = (await upstoxAuthService.getAccessToken()) || "";
        if (!token) {
            console.error("❌ No Upstox access token available. Aborting.");
            process.exit(1);
        }
    }

    const totals: Record<string, number> = {};

    for (const seg of segments) {
        if (seg === "daily-eq") {
            const rows = await findMissingDailyEquity();
            report("nse_equity (daily)", rows);
            if (!dryRun) totals[seg] = await fillDailyEquity(rows, token);
        } else if (seg === "daily-fut") {
            const rows = await findMissingDailySymbols("FUT");
            report("nse_futures (daily)", rows);
            if (!dryRun) totals[seg] = await fillDailySymbols(rows, "FUT", token);
        } else if (seg === "daily-opt") {
            const rows = await findMissingDailySymbols("OPT");
            report("nse_options (daily)", rows);
            if (!dryRun) totals[seg] = await fillDailySymbols(rows, "OPT", token);
        } else if (seg === "ticks-eq") {
            const rows = await findMissingTicksEquity();
            report("ticksDataNSEEQ (5-min)", rows);
            if (!dryRun)
                totals[seg] = await fillTicks(rows, seg, true, (chunk) =>
                    prisma.ticksDataNSEEQ.createMany({ data: chunk, skipDuplicates: true }), token);
        } else if (seg === "ticks-fut") {
            const rows = await findMissingTicksSymbols("FUT");
            report("ticksDataNSEFUT (5-min)", rows);
            if (!dryRun)
                totals[seg] = await fillTicks(rows, seg, false, (chunk) =>
                    prisma.ticksDataNSEFUT.createMany({ data: chunk, skipDuplicates: true }), token);
        } else if (seg === "ticks-opt") {
            const rows = await findMissingTicksSymbols("OPT");
            report("ticksDataNSEOPT (5-min)", rows);
            if (!dryRun)
                totals[seg] = await fillTicks(rows, seg, false, (chunk) =>
                    prisma.ticksDataNSEOPT.createMany({ data: chunk, skipDuplicates: true }), token);
        }
    }

    if (!dryRun) {
        console.log(`\n✅ Backfill complete:`);
        for (const [seg, count] of Object.entries(totals)) {
            console.log(`   - ${seg}: ${count} records inserted`);
        }
    }
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error("❌ Backfill script failed:", err);
        await prisma.$disconnect();
        process.exit(1);
    });
