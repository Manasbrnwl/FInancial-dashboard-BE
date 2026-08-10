import path from "path";
import fs from "fs";
import axios from "axios";
import prisma from "../config/prisma";
import { loadEnv } from "../config/env";
import { parseCsv, generateDates } from "./fetchHistoricalSymbols";
import { toDateOnly } from "../utils/istDate";

loadEnv();

/**
 * bse_equity has been stuck at 2025-09-12 for the whole segment (245 of 278
 * F&O-adjacent names) plus more names entirely. Root cause: getBseEquityHistory
 * (src/bseEquity/bseEquityHistory.ts), the only code that ever wrote to this
 * table, is never called anywhere -- not wired to any cron/script, dead since
 * it was written. It also depends on a DhanHQ access token/dhanTokenManager
 * module that doesn't exist in this codebase and isn't configured in .env, so
 * even wiring it up wouldn't work without external account setup.
 *
 * BSE publishes the same UDiFF-format bhavcopy NSE does (just BSE_CM instead
 * of NSE_FO/NSE_CM), no auth needed:
 *   https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{YYYYMMDD}_F_0000.CSV
 * (plain CSV, not zipped, unlike NSE's).
 *
 * Usage:
 *   npx ts-node src/scripts/fillBseEquityFromBhavcopy.ts --dry-run
 *   npx ts-node src/scripts/fillBseEquityFromBhavcopy.ts [--since YYYY-MM-DD]
 */

const SCRATCH_DIR = path.resolve(__dirname, "../../scratch/bse_bhavcopy");
const POLITE_DELAY_MS = 500;

function fmt(d: Date): string {
    return d.toISOString().split("T")[0];
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function downloadCsv(url: string, destPath: string): Promise<boolean> {
    try {
        const response = await axios({
            method: "get",
            url,
            responseType: "stream",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                Accept: "*/*",
            },
            timeout: 15000,
        });
        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);
        await new Promise<void>((resolve, reject) => {
            writer.on("finish", () => resolve());
            writer.on("error", reject);
        });
        // BSE serves its Angular app shell (HTML) with a 200 status for
        // dates/paths that don't exist -- detect and reject that instead of
        // treating it as a valid empty/short CSV.
        const head = fs.readFileSync(destPath, { encoding: "utf-8", flag: "r" }).slice(0, 20);
        if (head.trim().startsWith("<!DOCTYPE") || head.trim().startsWith("<html")) {
            fs.unlinkSync(destPath);
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

async function fillOneDate(dateKey: string, dryRun: boolean): Promise<{ found: boolean; inserted: number }> {
    const dateStr = dateKey.replace(/-/g, "");
    const url = `https://www.bseindia.com/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_${dateStr}_F_0000.CSV`;
    const csvPath = path.join(SCRATCH_DIR, `BSE_${dateStr}.CSV`);

    const ok = await downloadCsv(url, csvPath);
    if (!ok) return { found: false, inserted: 0 };

    const records: any[] = [];
    await parseCsv(csvPath, (row) => {
        if (row.Sgmt !== "CM") return; // equity cash market only
        const open = parseFloat(row.OpnPric) || 0;
        const high = parseFloat(row.HghPric) || 0;
        const low = parseFloat(row.LwPric) || 0;
        const close = parseFloat(row.ClsPric) || 0;
        if (open === 0 && high === 0 && low === 0 && close === 0) return;

        records.push({
            symbol_id: row.FinInstrmId || null,
            symbol: row.TckrSymb,
            date: toDateOnly(new Date(`${dateKey}T00:00:00Z`)),
            open,
            high,
            low,
            close,
            volume: row.TtlTradgVol || "0",
            oi: "0",
            exchange: "BSE",
        });
    });

    let inserted = 0;
    if (!dryRun && records.length > 0) {
        const result = await prisma.bse_equity.createMany({ data: records, skipDuplicates: true });
        inserted = result.count;
    }

    try {
        fs.unlinkSync(csvPath);
    } catch {
        // best-effort cleanup
    }

    return { found: true, inserted: dryRun ? records.length : inserted };
}

/**
 * Fills bse_equity from BSE's bhavcopy, from the day after the latest stored
 * date (or a caller-supplied sinceDate) through today. Exported so it can be
 * both a one-off CLI script and wired into a recurring cron -- see main()'s
 * CLI wrapper below for the --dry-run/--since flags.
 */
export async function runFillBseEquity(sinceDateArg?: Date, dryRun = false): Promise<{ checked: number; notFound: number; inserted: number }> {
    let sinceDate: Date;
    if (sinceDateArg) {
        sinceDate = sinceDateArg;
    } else {
        const row = await prisma.bse_equity.aggregate({ _max: { date: true } });
        sinceDate = row._max.date ? new Date(row._max.date.getTime() + 86400000) : new Date("2025-09-13");
    }
    const today = new Date();

    console.log(`Filling bse_equity from NSE-format BSE bhavcopy: ${fmt(sinceDate)} -> ${fmt(today)} (dry-run: ${dryRun})`);

    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    const dateStrs = generateDates(fmt(sinceDate), fmt(today)); // YYYYMMDD strings
    console.log(`Dates to check: ${dateStrs.length}`);

    let totalInserted = 0;
    let notFound = 0;
    let checked = 0;
    for (const ds of dateStrs) {
        const dateKey = `${ds.slice(0, 4)}-${ds.slice(4, 6)}-${ds.slice(6, 8)}`;
        const { found, inserted } = await fillOneDate(dateKey, dryRun);
        checked++;
        if (!found) {
            notFound++;
        } else if (inserted > 0) {
            console.log(`  ${dateKey}: ${inserted} rows ${dryRun ? "would be inserted" : "inserted"}`);
            totalInserted += inserted;
        }
        if (checked % 20 === 0) console.log(`  ...checked ${checked}/${dateStrs.length}`);
        await sleep(POLITE_DELAY_MS);
    }

    console.log(`\n✅ Done. Dates checked: ${dateStrs.length}, no bhavcopy (weekend/holiday): ${notFound}, rows inserted: ${totalInserted}`);
    return { checked: dateStrs.length, notFound, inserted: totalInserted };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const sinceIdx = args.indexOf("--since");
    const sinceDate = sinceIdx !== -1 && args[sinceIdx + 1] ? new Date(args[sinceIdx + 1]) : undefined;
    await runFillBseEquity(sinceDate, dryRun);
}

if (require.main === module) {
    main()
        .then(() => prisma.$disconnect())
        .catch(async (err) => {
            console.error("❌ fillBseEquityFromBhavcopy failed:", err);
            await prisma.$disconnect();
            process.exit(1);
        });
}
