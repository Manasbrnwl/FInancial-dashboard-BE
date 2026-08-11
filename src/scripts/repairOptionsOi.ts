import path from "path";
import fs from "fs";
import prisma from "../config/prisma";
import { loadEnv } from "../config/env";
import { insertChunked, sleep } from "./backfillMissingData";
import { downloadFile, extractZip, parseCsv, formatStrike } from "./fetchHistoricalSymbols";

loadEnv();

/**
 * Repairs nse_options.oi where it's stuck at 0/NULL. Originally written for
 * the 2026-06-25 dailyOhlcUpstoxJob regression (processOptionsOhlc read from
 * Upstox's /v3/market-quote/ohlc endpoint, whose OhlcQuote/OhlcCandle types
 * carry no `oi` field at all) -- that job now fetches OI from the full-quote
 * endpoint directly, so this should no longer be needed for new days. Kept
 * as a rolling safety net (see runRepairOptionsOi's default window below) in
 * case that fetch misses symbols on a given day (rate limits, transient
 * errors, a symbol Upstox briefly doesn't recognize).
 *
 * This uses NSE's bhavcopy archive (no Upstox token needed) via the same
 * normalized ticker+expiry+strike+type matching already proven in
 * fillGapsFromNseBhavcopy.ts, but as an UPDATE against existing rows instead
 * of an insert, since these rows already exist with wrong OI.
 *
 * Usage:
 *   npx ts-node src/scripts/repairOptionsOi.ts --dry-run
 *   npx ts-node src/scripts/repairOptionsOi.ts [--since YYYY-MM-DD]
 */

const SCRATCH_DIR = path.resolve(__dirname, "../../scratch/oi_repair");
const POLITE_DELAY_MS = 500;

function optMatchKey(instrumentType: string, expiryDateIso: string, strike: string | null, optionType: string | null): string {
    return `${instrumentType}|${expiryDateIso}|${strike}|${optionType}`;
}

function fmt(d: Date): string {
    return d.toISOString().split("T")[0];
}

async function getAffectedDates(sinceDateStr: string): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ date: Date }>>`
        SELECT DISTINCT date FROM market_data.nse_options
        WHERE date >= ${sinceDateStr}::date AND (oi IS NULL OR oi = '0')
        ORDER BY date
    `;
    return rows.map((r) => fmt(r.date));
}

async function getSymbolsForDate(dateKey: string): Promise<Map<string, { id: number; strike: string | null; option_type: string | null; instrument_type: string }>> {
    const rows = await prisma.$queryRaw<
        Array<{ id: number; strike: string | null; option_type: string | null; expiry_date: Date; instrument_type: string }>
    >`
        SELECT sl.id, sl.strike, sl.option_type, sl.expiry_date, il.instrument_type
        FROM market_data.nse_options no
        JOIN market_data.symbols_list sl ON sl.id = no.symbol
        JOIN market_data.instrument_lists il ON il.id = sl.instrument_id
        WHERE no.date = ${dateKey}::date AND (no.oi IS NULL OR no.oi = '0')
        GROUP BY sl.id, sl.strike, sl.option_type, sl.expiry_date, il.instrument_type
    `;
    const map = new Map<string, { id: number; strike: string | null; option_type: string | null; instrument_type: string }>();
    for (const r of rows) {
        const key = optMatchKey(r.instrument_type, fmt(r.expiry_date), r.strike, r.option_type);
        map.set(key, { id: r.id, strike: r.strike, option_type: r.option_type, instrument_type: r.instrument_type });
    }
    return map;
}

async function repairOneDate(dateKey: string, dryRun: boolean): Promise<{ found: boolean; matched: number; updated: number }> {
    const missing = await getSymbolsForDate(dateKey);
    if (missing.size === 0) return { found: true, matched: 0, updated: 0 };

    const dateStr = dateKey.replace(/-/g, "");
    const foUrl = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${dateStr}_F_0000.csv.zip`;
    const zipPath = path.join(SCRATCH_DIR, `FO_${dateStr}.zip`);
    const extractDir = path.join(SCRATCH_DIR, `FO_${dateStr}`);

    const ok = await downloadFile(foUrl, zipPath);
    if (!ok) return { found: false, matched: 0, updated: 0 };
    if (!extractZip(zipPath, extractDir)) return { found: false, matched: 0, updated: 0 };
    const files = fs.readdirSync(extractDir).filter((f) => f.toLowerCase().endsWith(".csv"));
    if (files.length === 0) return { found: false, matched: 0, updated: 0 };
    const csvPath = path.join(extractDir, files[0]);

    const updates: Array<{ id: number; oi: string }> = [];
    await parseCsv(csvPath, (row) => {
        const optType = row.OptnTp;
        if (!optType || optType === "XX" || optType === "") return; // OPT only
        const key = optMatchKey(row.TckrSymb, row.XpryDt, formatStrike(row.StrkPric), optType);
        const symbol = missing.get(key);
        if (!symbol) return;
        const oi = row.OpnIntrst || "0";
        if (oi === "0") return; // nothing to repair with
        updates.push({ id: symbol.id, oi });
    });

    let updated = 0;
    if (!dryRun && updates.length > 0) {
        updated = await insertChunked(updates, (chunk) =>
            prisma.$transaction(
                async (tx) => {
                    await tx.$executeRawUnsafe("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0");
                    // Single bulk UPDATE via unnest, not a per-row loop -- a loop of
                    // 1000 individual round-trips per chunk blew the transaction
                    // timeout on the very first date (28k rows).
                    const ids = chunk.map((u) => u.id);
                    const ois = chunk.map((u) => u.oi);
                    const count = await tx.$executeRaw`
                        UPDATE market_data.nse_options t
                        SET oi = c.oi
                        FROM (SELECT unnest(${ids}::int[]) AS sid, unnest(${ois}::text[]) AS oi) c
                        WHERE t.symbol = c.sid AND t.date = ${dateKey}::date
                    `;
                    return { count };
                },
                { timeout: 60000 }
            )
        );
    }

    try {
        fs.unlinkSync(zipPath);
        fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }

    return { found: true, matched: updates.length, updated: dryRun ? updates.length : updated };
}

/**
 * Repairs nse_options.oi from `sinceDate` onward (default: 14 days ago, a
 * rolling window sized for the recurring safety-net cron -- see
 * runRepairOptionsOi in sync.ts). Exported so it can be both a one-off CLI
 * script (for a wider historical repair, via --since) and wired into a cron.
 */
export async function runRepairOptionsOi(sinceDate?: Date, dryRun = false): Promise<{ datesChecked: number; notFound: number; matched: number; updated: number }> {
    const effectiveSince = sinceDate ?? new Date(Date.now() - 14 * 86400000);
    const sinceDateStr = fmt(effectiveSince);
    console.log(`Repairing nse_options.oi via NSE bhavcopy since ${sinceDateStr} (dry-run: ${dryRun})`);

    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    const dates = await getAffectedDates(sinceDateStr);
    console.log(`Affected dates: ${dates.length}`);

    let totalMatched = 0;
    let totalUpdated = 0;
    let notFound = 0;
    for (const dateKey of dates) {
        const { found, matched, updated } = await repairOneDate(dateKey, dryRun);
        if (!found) {
            notFound++;
            console.log(`  ⚠️  No bhavcopy for ${dateKey}`);
        } else {
            console.log(`  ${dateKey}: ${matched} rows have real OI in bhavcopy, ${dryRun ? "(dry-run)" : `${updated} updated`}`);
            totalMatched += matched;
            totalUpdated += updated;
        }
        await sleep(POLITE_DELAY_MS);
    }

    console.log(`\n✅ Done. Dates checked: ${dates.length}, no bhavcopy: ${notFound}, rows with real OI found: ${totalMatched}, updated: ${totalUpdated}`);
    return { datesChecked: dates.length, notFound, matched: totalMatched, updated: totalUpdated };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const sinceIdx = args.indexOf("--since");
    const sinceDate = sinceIdx !== -1 && args[sinceIdx + 1] ? new Date(args[sinceIdx + 1]) : undefined;
    await runRepairOptionsOi(sinceDate, dryRun);
}

if (require.main === module) {
    main()
        .then(() => prisma.$disconnect())
        .catch(async (err) => {
            console.error("❌ repairOptionsOi failed:", err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
