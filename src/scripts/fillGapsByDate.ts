import prisma from "../config/prisma";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { loadEnv } from "../config/env";
import { toDateOnly } from "../utils/istDate";
import {
    START,
    RATE_LIMIT_DELAY_MS,
    findMissingDailySymbols,
    fetchCandles,
    dailyUrl,
    insertChunked,
    fmt,
    sleep,
    MissingSymbol,
} from "./backfillMissingData";

loadEnv();

/**
 * Date-first version of backfillMissingData's daily-fut/daily-opt fill.
 *
 * backfillMissingData fetches one Upstox range call per SYMBOL, spanning that
 * symbol's first-to-last missing date (which can pull back already-present
 * days in between, harmless under skipDuplicates but not surgical). This
 * script instead groups the same missing (symbol, date) pairs by DATE, prints
 * the full list of gap dates, then makes one Upstox call per (missing symbol,
 * missing date) with from=to=that single day -- only the exact gaps, nothing
 * either side of them.
 *
 * Usage:
 *   npx ts-node src/scripts/fillGapsByDate.ts --dry-run [--segments daily-fut,daily-opt]
 *   npx ts-node src/scripts/fillGapsByDate.ts [--segments daily-fut,daily-opt]
 */

const ALL_SEGMENTS = ["daily-fut", "daily-opt"] as const;
type Segment = (typeof ALL_SEGMENTS)[number];

interface GapSlot {
    date: string;
    segment: "FUT" | "OPT";
    symbol: MissingSymbol;
}

async function buildGapsByDate(segments: Segment[]): Promise<Map<string, GapSlot[]>> {
    const byDate = new Map<string, GapSlot[]>();

    for (const seg of segments) {
        const segment: "FUT" | "OPT" = seg === "daily-fut" ? "FUT" : "OPT";
        // OPT: only treat a missing day as a real gap for symbols that have
        // traded at least once elsewhere -- a symbol with zero data ever is
        // almost certainly just untraded, not a sync failure (confirmed: the
        // unscoped run found 1.56M "missing" slots, nearly all this pattern).
        const requireExistingData = segment === "OPT";
        console.log(`Finding missing ${segment} days since ${START}${requireExistingData ? " (symbols with existing data only)" : ""}...`);
        const rows = await findMissingDailySymbols(segment, { requireExistingData });
        for (const row of rows) {
            for (const d of row.missing_dates) {
                const key = fmt(d);
                const list = byDate.get(key) || [];
                list.push({ date: key, segment, symbol: row });
                byDate.set(key, list);
            }
        }
    }

    return byDate;
}

/**
 * Weekends are already excluded at the calendar level (see backfillMissingData's
 * cal CTE comment), but a handful of weekday dates in nse_equity are also
 * mis-dated onto real NSE holidays -- on those, EVERY contract looks "missing"
 * since the market was actually closed, not because sync failed. Fetching
 * those would just be hundreds of API calls confirming emptiness. Flag any
 * date where a segment's missing count is >=85% of that segment's own
 * busiest day as "suspected non-trading day" and skip it rather than guess.
 */
function splitSuspectedHolidays(byDate: Map<string, GapSlot[]>): { real: Map<string, GapSlot[]>; suspected: Map<string, GapSlot[]> } {
    const rosterEstimate: Record<"FUT" | "OPT", number> = { FUT: 0, OPT: 0 };
    for (const slots of byDate.values()) {
        for (const seg of ["FUT", "OPT"] as const) {
            const count = slots.filter((s) => s.segment === seg).length;
            rosterEstimate[seg] = Math.max(rosterEstimate[seg], count);
        }
    }

    const real = new Map<string, GapSlot[]>();
    const suspected = new Map<string, GapSlot[]>();
    for (const [date, slots] of byDate) {
        const isSuspected = (["FUT", "OPT"] as const).some((seg) => {
            const count = slots.filter((s) => s.segment === seg).length;
            return rosterEstimate[seg] > 0 && count >= 0.85 * rosterEstimate[seg];
        });
        (isSuspected ? suspected : real).set(date, slots);
    }
    return { real, suspected };
}

function printGapDates(label: string, byDate: Map<string, GapSlot[]>): void {
    const dates = [...byDate.keys()].sort();
    console.log(`\n📅 ${label}: ${dates.length}`);
    for (const date of dates) {
        const slots = byDate.get(date)!;
        const futCount = slots.filter((s) => s.segment === "FUT").length;
        const optCount = slots.filter((s) => s.segment === "OPT").length;
        console.log(`   ${date}: ${slots.length} missing symbols (FUT ${futCount}, OPT ${optCount})`);
    }
}

async function fillOneDay(slot: GapSlot, token: string): Promise<number> {
    const { date, segment, symbol } = slot;
    const candles = await fetchCandles(dailyUrl(symbol.upstox_id, date, date), token);
    const records = candles
        .filter((c) => c.open !== 0 || c.high !== 0 || c.low !== 0 || c.close !== 0)
        .map((c) => ({
            symbol_id: symbol.id.toString(),
            symbol: symbol.id,
            date: toDateOnly(new Date(c.timestamp)),
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume.toString(),
            oi: c.oi.toString(),
            underlying: symbol.instrument_id,
            expiry_date: symbol.expiry_date,
            ...(segment === "OPT"
                ? { strike: symbol.strike, option_type: symbol.option_type, expiry_month: symbol.expiry_month }
                : {}),
        }));

    if (records.length === 0) return 0;

    return insertChunked(records, (chunk) =>
        segment === "FUT"
            ? prisma.nse_futures.createMany({ data: chunk, skipDuplicates: true })
            : prisma.nse_options.createMany({ data: chunk, skipDuplicates: true })
    );
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

    console.log(`🚀 Date-grouped gap fill after ${START} (dry-run: ${dryRun})`);
    console.log(`📊 Segments: ${segments.join(", ")}`);

    const allGaps = await buildGapsByDate(segments);
    const { real, suspected } = splitSuspectedHolidays(allGaps);

    printGapDates("Gap dates (will fetch)", real);
    printGapDates("Suspected non-trading days (skipped, not fetched)", suspected);

    const totalSlots = [...real.values()].reduce((sum, slots) => sum + slots.length, 0);
    const skippedSlots = [...suspected.values()].reduce((sum, slots) => sum + slots.length, 0);
    console.log(`\nTotal missing (symbol, date) slots to fetch: ${totalSlots} (skipped ${skippedSlots} on suspected non-trading days)`);

    if (dryRun) return;

    const token = (await upstoxAuthService.getAccessToken()) || "";
    if (!token) {
        console.error("❌ No Upstox access token available. Aborting.");
        process.exit(1);
    }

    const dates = [...real.keys()].sort();
    let inserted = 0;
    let processed = 0;
    for (const date of dates) {
        for (const slot of real.get(date)!) {
            inserted += await fillOneDay(slot, token);
            processed++;
            if (processed % 200 === 0) console.log(`  ✅ ${processed}/${totalSlots} slots processed`);
            await sleep(RATE_LIMIT_DELAY_MS);
        }
    }

    console.log(`\n✅ Fill complete: ${inserted} records inserted across ${processed} (symbol, date) slots`);
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error("❌ fillGapsByDate failed:", err);
        await prisma.$disconnect();
        process.exit(1);
    });
