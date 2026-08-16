import path from "path";
import fs from "fs";
import prisma from "../config/prisma";
import { loadEnv } from "../config/env";
import { START, findMissingDailySymbols, insertChunked, fmt, sleep, MissingSymbol } from "./backfillMissingData";
import { downloadFile, extractZip, parseCsv, getOptionOrFutureSymbol, formatStrike } from "./fetchHistoricalSymbols";

loadEnv();

/**
 * Fills nse_futures/nse_options gaps from NSE's own public bhavcopy archive
 * instead of Upstox. Upstox only publishes instrument keys for currently
 * listed contracts, so once a contract expires there's no way to look up a
 * valid key for it anymore -- historical-candle calls fail permanently with
 * "Invalid Instrument key" (confirmed for ~1,000 of the futures gap slots
 * found this session). NSE's bhavcopy files are the permanent settlement
 * record for every past trading day and identify contracts by ticker/expiry/
 * strike, not a rotating token, so this works for already-expired contracts.
 *
 * One bhavcopy ZIP covers every FUT+OPT contract for a single day, so this
 * is one download per gap DATE rather than one API call per (symbol, date).
 *
 * Usage:
 *   npx ts-node src/scripts/fillGapsFromNseBhavcopy.ts --dry-run [--segments daily-fut,daily-opt]
 *   npx ts-node src/scripts/fillGapsFromNseBhavcopy.ts [--segments daily-fut,daily-opt]
 */

const ALL_SEGMENTS = ["daily-fut", "daily-opt"] as const;
type Segment = (typeof ALL_SEGMENTS)[number];

const SCRATCH_DIR = path.resolve(__dirname, "../../scratch/bhavcopy_gapfill");
const POLITE_DELAY_MS = 500;

/**
 * FUT: our stored symbol string (TICKER+YY+MON+FUT) matches NSE bhavcopy's
 * FinInstrmNm exactly, so plain string matching works.
 *
 * OPT: our stored symbol string uses Upstox's full-date convention
 * (TICKER+YYMMDD+STRIKE+CE/PE, e.g. PNB251230116PE), but NSE bhavcopy's
 * FinInstrmNm uses a month-abbreviated convention for the same contract
 * (PNB25DEC119PE) -- two vendors, two naming conventions, same contract.
 * Exact string matching between them always fails. Match on normalized
 * fields instead (ticker + expiry date + strike + option type), which both
 * sides can independently derive for the same real contract.
 */
function optMatchKey(instrumentType: string, expiryDateIso: string, strike: string | null, optionType: string | null): string {
    return `${instrumentType}|${expiryDateIso}|${strike}|${optionType}`;
}

async function buildMissingByDate(segments: Segment[]): Promise<Map<string, Map<string, Map<string, MissingSymbol>>>> {
    // date -> segment -> match key (symbol string for FUT, normalized key for OPT) -> row
    const byDate = new Map<string, Map<string, Map<string, MissingSymbol>>>();

    for (const seg of segments) {
        const segment: "FUT" | "OPT" = seg === "daily-fut" ? "FUT" : "OPT";
        const requireExistingData = segment === "OPT";
        console.log(`Finding missing ${segment} days since ${START}...`);
        const rows = await findMissingDailySymbols(segment, { requireExistingData });
        for (const row of rows) {
            const key = segment === "FUT"
                ? row.symbol
                : optMatchKey(row.instrument_type, fmt(row.expiry_date), row.strike, row.option_type);
            for (const d of row.missing_dates) {
                const dateKey = fmt(d);
                const bySeg = byDate.get(dateKey) ?? new Map<string, Map<string, MissingSymbol>>();
                const byKey = bySeg.get(segment) ?? new Map<string, MissingSymbol>();
                byKey.set(key, row);
                bySeg.set(segment, byKey);
                byDate.set(dateKey, bySeg);
            }
        }
    }

    return byDate;
}

function toDateStr(dateKey: string): string {
    return dateKey.replace(/-/g, "");
}

function parsePrice(s: string): number {
    const n = parseFloat(s);
    return isNaN(n) ? 0 : n;
}

async function fillOneDate(dateKey: string, bySeg: Map<string, Map<string, MissingSymbol>>): Promise<{ inserted: number; found: boolean }> {
    const dateStr = toDateStr(dateKey);
    const foUrl = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${dateStr}_F_0000.csv.zip`;
    const zipPath = path.join(SCRATCH_DIR, `FO_${dateStr}.zip`);
    const extractDir = path.join(SCRATCH_DIR, `FO_${dateStr}`);

    const ok = await downloadFile(foUrl, zipPath);
    if (!ok) return { inserted: 0, found: false };

    if (!extractZip(zipPath, extractDir)) return { inserted: 0, found: false };
    const files = fs.readdirSync(extractDir).filter((f) => f.toLowerCase().endsWith(".csv"));
    if (files.length === 0) return { inserted: 0, found: false };
    const csvPath = path.join(extractDir, files[0]);

    const futMissing = bySeg.get("FUT");
    const optMissing = bySeg.get("OPT");
    const futRecords: any[] = [];
    const optRecords: any[] = [];

    await parseCsv(csvPath, (row) => {
        const optType = row.OptnTp;
        const isFut = !optType || optType === "XX" || optType === "";
        const missingMap = isFut ? futMissing : optMissing;
        if (!missingMap) return;

        const key = isFut
            ? row.FinInstrmNm || getOptionOrFutureSymbol(row)
            : optMatchKey(row.TckrSymb, row.XpryDt, formatStrike(row.StrkPric), optType);
        const missing = missingMap.get(key);
        if (!missing) return;

        const open = parsePrice(row.OpnPric);
        const high = parsePrice(row.HghPric);
        const low = parsePrice(row.LwPric);
        const close = parsePrice(row.ClsPric);
        if (open === 0 && high === 0 && low === 0 && close === 0) return;

        const base = {
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
        };

        if (isFut) {
            futRecords.push(base);
        } else {
            optRecords.push({ ...base, strike: missing.strike, option_type: missing.option_type, expiry_month: missing.expiry_month });
        }
    });

    let inserted = 0;
    if (futRecords.length > 0) {
        inserted += await insertChunked(futRecords, (chunk) => prisma.nse_futures.createMany({ data: chunk, skipDuplicates: true }));
    }
    if (optRecords.length > 0) {
        // nse_options is a compressed TimescaleDB hypertable; skipDuplicates's
        // ON CONFLICT check has to decompress whatever existing chunk a batch's
        // dates fall into, and older/denser chunks can exceed the default
        // per-transaction decompression cap regardless of our own batch size.
        // SET LOCAL scopes the raised limit to just this transaction.
        inserted += await insertChunked(optRecords, (chunk) =>
            prisma.$transaction(
                async (tx) => {
                    await tx.$executeRawUnsafe("SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0");
                    return tx.nse_options.createMany({ data: chunk, skipDuplicates: true });
                },
                { timeout: 60000 } // decompressing an older/dense chunk can genuinely take longer than Prisma's 5s default
            )
        );
    }

    try {
        fs.unlinkSync(zipPath);
        fs.rmSync(extractDir, { recursive: true, force: true });
    } catch {
        // best-effort cleanup
    }

    return { inserted, found: true };
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    let segments: Segment[] = ["daily-fut"];
    const segIdx = args.indexOf("--segments");
    if (segIdx !== -1 && args[segIdx + 1]) {
        segments = args[segIdx + 1]
            .split(",")
            .map((s) => s.trim())
            .filter((s): s is Segment => (ALL_SEGMENTS as readonly string[]).includes(s));
    }
    // Scope to specific dates (e.g. a known incident window) instead of the
    // full history back to START -- findMissingDailySymbols always walks the
    // whole calendar, so this just filters its result rather than skipping
    // the scan itself.
    const datesIdx = args.indexOf("--dates");
    const dateFilter = datesIdx !== -1 && args[datesIdx + 1]
        ? new Set(args[datesIdx + 1].split(",").map((s) => s.trim()))
        : null;

    console.log(`🚀 NSE bhavcopy gap fill after ${START} (dry-run: ${dryRun})`);
    console.log(`📊 Segments: ${segments.join(", ")}`);
    if (dateFilter) console.log(`📅 Restricted to dates: ${[...dateFilter].join(", ")}`);

    const byDateAll = await buildMissingByDate(segments);
    const byDate = dateFilter
        ? new Map([...byDateAll].filter(([d]) => dateFilter.has(d)))
        : byDateAll;
    const dates = [...byDate.keys()].sort();
    const totalSlots = dates.reduce((sum, d) => {
        const bySeg = byDate.get(d)!;
        return sum + [...bySeg.values()].reduce((s, m) => s + m.size, 0);
    }, 0);

    console.log(`\n📅 Gap dates: ${dates.length}, total missing (symbol, date) slots: ${totalSlots}`);
    for (const d of dates) {
        const bySeg = byDate.get(d)!;
        const futCount = bySeg.get("FUT")?.size ?? 0;
        const optCount = bySeg.get("OPT")?.size ?? 0;
        console.log(`   ${d}: FUT ${futCount}, OPT ${optCount}`);
    }

    if (dryRun) return;

    if (!fs.existsSync(SCRATCH_DIR)) fs.mkdirSync(SCRATCH_DIR, { recursive: true });

    let totalInserted = 0;
    let notFoundDates = 0;
    for (const d of dates) {
        const { inserted, found } = await fillOneDate(d, byDate.get(d)!);
        if (!found) {
            notFoundDates++;
            console.log(`  ⚠️  No bhavcopy found for ${d} (holiday, or not yet published)`);
        } else {
            console.log(`  ✅ ${d}: ${inserted} records inserted`);
            totalInserted += inserted;
        }
        await sleep(POLITE_DELAY_MS);
    }

    console.log(`\n✅ Fill complete: ${totalInserted} records inserted across ${dates.length - notFoundDates} bhavcopy files (${notFoundDates} dates had no file)`);
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error("❌ fillGapsFromNseBhavcopy failed:", err);
        await prisma.$disconnect();
        process.exit(1);
    });
