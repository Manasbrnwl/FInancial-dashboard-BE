import path from "path";
import fs from "fs";
import prisma from "../config/prisma";
import { loadEnv } from "../config/env";
import { downloadFile, extractZip, parseCsv } from "./fetchHistoricalSymbols";

loadEnv();

/**
 * One-off fill for nse_equity on specific dates where the daily Upstox job
 * skipped entirely (Upstox access token expired for ~2 days, 2026-08-12/13 --
 * see the outage this was written for). Sources from NSE's own CM (cash
 * market) bhavcopy instead of Upstox, so it doesn't depend on a valid Upstox
 * token at all.
 *
 * IMPORTANT: nse_equity.symbol stores instrument_lists.id as a string (not
 * the ticker) -- see the "nse_equity_symbol_key_regression" note; this
 * matches what dailyOhlcUpstoxJob's processEquityOhlc already writes
 * (symbol_id: inst.id, symbol: inst.id.toString()). Matched here for
 * consistency with every other row in the table, not "fixed" -- that's a
 * separate, bigger decision this script isn't the place for.
 *
 * Usage:
 *   npx ts-node src/scripts/fillNseEquityGapFromBhavcopy.ts --dry-run --dates 2026-08-12,2026-08-13
 *   npx ts-node src/scripts/fillNseEquityGapFromBhavcopy.ts --dates 2026-08-12,2026-08-13
 */

const SCRATCH_DIR = path.resolve(__dirname, "../../scratch/nse_equity_gapfill");
const POLITE_DELAY_MS = 500;

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function loadInstrumentMap(): Promise<Map<string, number>> {
    const rows = await prisma.instrument_lists.findMany({
        where: { exchange: "NSE" },
        select: { id: true, instrument_type: true },
    });
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.instrument_type, r.id);
    return map;
}

async function fillOneDate(dateKey: string, instrumentMap: Map<string, number>, dryRun: boolean): Promise<{ found: boolean; inserted: number; unmatched: number }> {
    const dateStr = dateKey.replace(/-/g, "");
    const url = `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${dateStr}_F_0000.csv.zip`;
    const zipPath = path.join(SCRATCH_DIR, `CM_${dateStr}.zip`);
    const extractDir = path.join(SCRATCH_DIR, `CM_${dateStr}`);

    const ok = await downloadFile(url, zipPath);
    if (!ok) return { found: false, inserted: 0, unmatched: 0 };
    if (!extractZip(zipPath, extractDir)) return { found: false, inserted: 0, unmatched: 0 };
    const files = fs.readdirSync(extractDir).filter((f) => f.toLowerCase().endsWith(".csv"));
    if (files.length === 0) return { found: false, inserted: 0, unmatched: 0 };
    const csvPath = path.join(extractDir, files[0]);

    const records: any[] = [];
    let unmatched = 0;
    await parseCsv(csvPath, (row) => {
        if (row.Sgmt !== "CM") return; // equity cash market only
        const ticker = row.TckrSymb;
        const instrumentId = instrumentMap.get(ticker);
        if (!instrumentId) {
            unmatched++;
            return;
        }
        const open = parseFloat(row.OpnPric) || 0;
        const high = parseFloat(row.HghPric) || 0;
        const low = parseFloat(row.LwPric) || 0;
        const close = parseFloat(row.ClsPric) || 0;
        if (open === 0 && high === 0 && low === 0 && close === 0) return;

        records.push({
            symbol_id: instrumentId,
            symbol: instrumentId.toString(),
            date: new Date(`${dateKey}T00:00:00.000Z`),
            open,
            high,
            low,
            close,
            volume: row.TtlTradgVol || "0",
            oi: "0",
            exchange: "NSE",
        });
    });

    let inserted = 0;
    if (!dryRun && records.length > 0) {
        const result = await prisma.nse_equity.createMany({ data: records, skipDuplicates: true });
        inserted = result.count;
    }

    try {
        fs.unlinkSync(zipPath);
        fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }

    return { found: true, inserted: dryRun ? records.length : inserted, unmatched };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const datesIdx = args.indexOf("--dates");
    if (datesIdx === -1 || !args[datesIdx + 1]) {
        console.error("Usage: --dates YYYY-MM-DD,YYYY-MM-DD [--dry-run]");
        process.exit(1);
    }
    const dates = args[datesIdx + 1].split(",");

    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    console.log("Loading NSE instrument map (ticker -> instrument_lists.id)...");
    const instrumentMap = await loadInstrumentMap();
    console.log(`Loaded ${instrumentMap.size} NSE instruments.\n`);

    for (const dateKey of dates) {
        console.log(`Processing ${dateKey}...`);
        const { found, inserted, unmatched } = await fillOneDate(dateKey, instrumentMap, dryRun);
        if (!found) {
            console.log(`  ⚠️  No bhavcopy found for ${dateKey}`);
        } else {
            console.log(`  ${dateKey}: ${inserted} rows ${dryRun ? "would be inserted" : "inserted"}, ${unmatched} tickers unmatched to instrument_lists`);
        }
        await sleep(POLITE_DELAY_MS);
    }

    console.log("\n✅ Done.");
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error("❌ fillNseEquityGapFromBhavcopy failed:", err);
        await prisma.$disconnect();
        process.exit(1);
    });
