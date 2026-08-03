import path from "path";
import fs from "fs";
import prisma from "../config/prisma";
import { loadEnv } from "../config/env";
import { START, findMissingDailySymbols, insertChunked, fmt, sleep, MissingSymbol } from "./backfillMissingData";
import { downloadFile, extractZip, parseCsv, getOptionOrFutureSymbol } from "./fetchHistoricalSymbols";

loadEnv();

/**
 * Follow-up to fillGapsFromNseBhavcopy.ts: for futures gap slots that still
 * have no data after the bhavcopy fill, determine WHY, rather than assume.
 *
 * While re-checking every gap date's bhavcopy, this also builds a global set
 * of every FinInstrmNm NSE actually published across all of them (~75 real
 * trading days spanning the whole gap window). A still-missing symbol that
 * never once appears in that set -- despite the window covering its claimed
 * trading life -- isn't a fetch failure, it's a symbols_list row that likely
 * doesn't correspond to any contract NSE ever listed. Those get reported and,
 * with --mark-invalid, flagged via the existing data_status='invalid' column
 * (never deleted -- just excluded from future gap scans, per convention).
 *
 * A symbol that DOES appear elsewhere in the window but not on its specific
 * missing date is a different, real case (worth listing separately, not
 * auto-flagged) -- printed but left alone.
 *
 * Usage:
 *   npx ts-node src/scripts/auditPhantomFutureGaps.ts                # report only
 *   npx ts-node src/scripts/auditPhantomFutureGaps.ts --mark-invalid # also flag confirmed phantoms
 */

const SCRATCH_DIR = path.resolve(__dirname, "../../scratch/bhavcopy_gapfill");
const POLITE_DELAY_MS = 500;

function toDateStr(dateKey: string): string {
    return dateKey.replace(/-/g, "");
}

function parsePrice(s: string): number {
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

async function main(): Promise<void> {
    const markInvalid = process.argv.includes("--mark-invalid");

    console.log(`Finding missing FUT days since ${START}...`);
    const rows = await findMissingDailySymbols("FUT");

    // date -> symbol -> row
    const byDate = new Map<string, Map<string, MissingSymbol>>();
    // symbol -> row (dedup for reporting)
    const allMissingSymbols = new Map<string, MissingSymbol>();
    for (const row of rows) {
        allMissingSymbols.set(row.symbol, row);
        for (const d of row.missing_dates) {
            const key = fmt(d);
            const bySymbol = byDate.get(key) ?? new Map<string, MissingSymbol>();
            bySymbol.set(row.symbol, row);
            byDate.set(key, bySymbol);
        }
    }

    const dates = [...byDate.keys()].sort();
    console.log(`Gap dates to re-check: ${dates.length}`);

    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    const everSeen = new Set<string>();
    // symbol -> set of dates where it was requested but not found in that day's file
    const stillMissingOn = new Map<string, string[]>();
    let filesFound = 0;
    let filesNotFound = 0;
    let newlyInserted = 0;

    for (const dateKey of dates) {
        const missingMap = byDate.get(dateKey)!;
        const dateStr = toDateStr(dateKey);
        const foUrl = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${dateStr}_F_0000.csv.zip`;
        const zipPath = path.join(SCRATCH_DIR, `FO_${dateStr}.zip`);
        const extractDir = path.join(SCRATCH_DIR, `FO_${dateStr}`);

        const ok = await downloadFile(foUrl, zipPath);
        if (!ok) {
            filesNotFound++;
            await sleep(POLITE_DELAY_MS);
            continue;
        }
        if (!extractZip(zipPath, extractDir)) {
            filesNotFound++;
            continue;
        }
        const files = fs.readdirSync(extractDir).filter((f) => f.toLowerCase().endsWith(".csv"));
        if (files.length === 0) {
            filesNotFound++;
            continue;
        }
        filesFound++;
        const csvPath = path.join(extractDir, files[0]);

        const matchedToday = new Set<string>();
        const records: any[] = [];

        await parseCsv(csvPath, (row) => {
            const optType = row.OptnTp;
            if (!(!optType || optType === "XX" || optType === "")) return; // FUT only
            const symbol = row.FinInstrmNm || getOptionOrFutureSymbol(row);
            everSeen.add(symbol);

            const missing = missingMap.get(symbol);
            if (!missing) return;
            matchedToday.add(symbol);

            const open = parsePrice(row.OpnPric);
            const high = parsePrice(row.HghPric);
            const low = parsePrice(row.LwPric);
            const close = parsePrice(row.ClsPric);
            if (open === 0 && high === 0 && low === 0 && close === 0) return;

            records.push({
                symbol_id: missing.id.toString(),
                symbol: missing.id,
                date: new Date(`${dateKey}T00:00:00Z`),
                open,
                high,
                low,
                close,
                volume: row.TtlTradgVol || "0",
                oi: row.OpnIntrst || "0",
                underlying: missing.instrument_id,
                expiry_date: missing.expiry_date,
            });
        });

        if (records.length > 0) {
            newlyInserted += await insertChunked(records, (chunk) => prisma.nse_futures.createMany({ data: chunk, skipDuplicates: true }));
        }

        for (const symbol of missingMap.keys()) {
            if (!matchedToday.has(symbol)) {
                const list = stillMissingOn.get(symbol) ?? [];
                list.push(dateKey);
                stillMissingOn.set(symbol, list);
            }
        }

        try {
            fs.unlinkSync(zipPath);
            fs.rmSync(extractDir, { recursive: true, force: true });
        } catch {
            // best-effort cleanup
        }
        await sleep(POLITE_DELAY_MS);
    }

    console.log(`\nBhavcopy files found: ${filesFound}, not found (holidays): ${filesNotFound}`);
    console.log(`Newly inserted this pass: ${newlyInserted}`);

    const confirmedPhantom: string[] = [];
    const realResidualGap: Array<{ symbol: string; dates: string[] }> = [];
    for (const [symbol, dateList] of stillMissingOn) {
        if (everSeen.has(symbol)) {
            realResidualGap.push({ symbol, dates: dateList });
        } else {
            confirmedPhantom.push(symbol);
        }
    }

    console.log(`\n👻 Confirmed phantom symbols (never appeared in any of the ${filesFound} bhavcopy files checked): ${confirmedPhantom.length}`);
    for (const symbol of confirmedPhantom) {
        const row = allMissingSymbols.get(symbol)!;
        console.log(`   ${symbol} (id=${row.id}, expiry=${fmt(row.expiry_date)}, upstox_id=${row.upstox_id})`);
    }

    console.log(`\n🔎 Real residual gaps (symbol exists elsewhere in the window, but missing on specific dates): ${realResidualGap.length}`);
    for (const { symbol, dates: ds } of realResidualGap) {
        console.log(`   ${symbol}: missing on ${ds.join(", ")}`);
    }

    if (markInvalid && confirmedPhantom.length > 0) {
        const ids = confirmedPhantom.map((s) => allMissingSymbols.get(s)!.id);
        // Raw query: data_status isn't always present in the currently
        // deployed schema.prisma's generated client (see backfillMissingData
        // for the full note), so this goes straight to the column.
        const result = await prisma.$executeRaw`
            UPDATE market_data.symbols_list SET data_status = 'invalid' WHERE id = ANY(${ids})
        `;
        console.log(`\n✅ Marked ${result} symbols_list rows as data_status='invalid'.`);
    } else if (confirmedPhantom.length > 0) {
        console.log(`\nRun with --mark-invalid to flag these ${confirmedPhantom.length} rows as data_status='invalid' (excludes them from future gap scans; does not delete anything).`);
    }
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error("❌ auditPhantomFutureGaps failed:", err);
        await prisma.$disconnect();
        process.exit(1);
    });
