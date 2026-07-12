import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import axios from "axios";
import { execSync } from "child_process";
import * as readline from "readline";
import { PrismaClient } from "@prisma/client";

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const prisma = new PrismaClient();

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");

// Date range configuration
const START_DATE = "2025-07-08";
const END_DATE = "2026-01-06";

// Temp working path
const scratchDir = path.resolve(__dirname, "../scratch/temp_bhavcopy_ohlc");

// Ensure temp directory exists
if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}

interface InstrumentCache {
    id: number;
    instrument_type: string;
    upstox_id: string | null;
}

interface SymbolCache {
    id: number;
    instrument_id: number;
    symbol: string;
    segment: string | null;
    expiry_date: Date | null;
    strike: string | null;
    option_type: string | null;
    expiry_month: string | null;
}

/**
 * Generates an array of date strings in YYYYMMDD format between start and end dates.
 */
function generateDates(start: string, end: string): string[] {
    const dates: string[] = [];
    const current = new Date(start);
    const last = new Date(end);

    while (current <= last) {
        const year = current.getFullYear();
        const month = String(current.getMonth() + 1).padStart(2, "0");
        const day = String(current.getDate()).padStart(2, "0");
        dates.push(`${year}${month}${day}`);
        current.setDate(current.getDate() + 1);
    }
    return dates;
}

/**
 * Downloads a file from the given URL and saves it to the destination path.
 */
async function downloadFile(url: string, destPath: string): Promise<boolean> {
    try {
        const response = await axios({
            method: "get",
            url: url,
            responseType: "stream",
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
                "Accept": "*/*"
            },
            timeout: 15000
        });

        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);

        await new Promise<void>((resolve, reject) => {
            writer.on("finish", () => resolve());
            writer.on("error", (err) => reject(err));
        });

        // NSE sometimes serves a "file not available yet" HTML page with
        // HTTP 200 instead of the archive — verify the ZIP magic bytes.
        if (!isZipFile(destPath)) {
            fs.unlinkSync(destPath);
            return false;
        }

        return true;
    } catch (error: any) {
        return false;
    }
}

/**
 * Checks whether a file starts with the ZIP local-file-header magic number.
 */
function isZipFile(filePath: string): boolean {
    const fd = fs.openSync(filePath, "r");
    try {
        const magic = Buffer.alloc(4);
        const bytesRead = fs.readSync(fd, magic, 0, 4, 0);
        return bytesRead === 4 && magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Extracts a ZIP archive to the target destination directory using PowerShell.
 */
function extractZip(zipPath: string, destDir: string): boolean {
    try {
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: "ignore" });
        return true;
    } catch (error: any) {
        console.error(`❌ Extraction error for ${zipPath}: ${error.message}`);
        return false;
    }
}

/**
 * Parses a CSV file line by line and passes each row object to the callback.
 */
async function parseCsv(csvPath: string, onRow: (row: Record<string, string>) => void): Promise<number> {
    const fileStream = fs.createReadStream(csvPath);
    const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
    });

    let headers: string[] = [];
    let count = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        const columns = line.split(",").map(c => c.trim());
        if (headers.length === 0) {
            headers = columns;
            continue;
        }

        const row: Record<string, string> = {};
        for (let i = 0; i < headers.length; i++) {
            row[headers[i]] = columns[i] || "";
        }
        onRow(row);
        count++;
    }
    return count;
}

/**
 * Slices off unnecessary decimals from a strike price.
 */
function formatStrike(strikeStr: string): string {
    const num = parseFloat(strikeStr);
    if (isNaN(num)) return strikeStr;
    return num.toString();
}

/**
 * Reconstructs the contract symbol key if FinInstrmNm is missing.
 */
function getOptionOrFutureSymbol(row: Record<string, string>): string {
    if (row.FinInstrmNm) {
        return row.FinInstrmNm;
    }

    const expiryDate = new Date(`${row.XpryDt}T00:00:00Z`);
    const yy = expiryDate.getUTCFullYear().toString().slice(-2);
    const mon = expiryDate.toLocaleString("default", { month: "short", timeZone: "UTC" }).toUpperCase();

    if (!row.OptnTp || row.OptnTp === "XX" || row.OptnTp === "") {
        return `${row.TckrSymb}${yy}${mon}FUT`;
    } else {
        const strikeStr = formatStrike(row.StrkPric);
        return `${row.TckrSymb}${yy}${mon}${strikeStr}${row.OptnTp}`;
    }
}

/**
 * Alternate symbol key using numeric YYMMDD expiry instead of the 3-letter
 * month NSE uses in FinInstrmNm. Contracts created via the Upstox instrument
 * sync after its tradingSymbol format switched are stored in this form
 * (e.g. "M&M2601273700PE" vs NSE's own "M&M26JAN3700PE"), so a name-only
 * lookup against older Bhavcopy files misses them entirely without this.
 */
function getOptionOrFutureSymbolNumeric(row: Record<string, string>): string {
    const expiryDate = new Date(`${row.XpryDt}T00:00:00Z`);
    const yy = expiryDate.getUTCFullYear().toString().slice(-2);
    const mm = String(expiryDate.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(expiryDate.getUTCDate()).padStart(2, "0");

    if (!row.OptnTp || row.OptnTp === "XX" || row.OptnTp === "") {
        return `${row.TckrSymb}${yy}${mm}${dd}FUT`;
    } else {
        const strikeStr = formatStrike(row.StrkPric);
        return `${row.TckrSymb}${yy}${mm}${dd}${strikeStr}${row.OptnTp}`;
    }
}

/**
 * Helper to split an array into chunks of a given size.
 */
function chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * Decompresses any compressed TimescaleDB chunks for the target date
 * across nse_equity, nse_futures, and nse_options tables.
 */
async function decompressChunksForDate(dateStr: string) {
    try {
        const compressedChunks: any[] = await prisma.$queryRawUnsafe(`
            SELECT 
                hypertable_name::text as table_name,
                chunk_schema::text || '.' || chunk_name::text AS chunk_full_name
            FROM timescaledb_information.chunks
            WHERE hypertable_name IN ('nse_equity', 'nse_futures', 'nse_options')
              AND range_start <= '${dateStr}'::timestamp 
              AND range_end > '${dateStr}'::timestamp
              AND is_compressed = true;
        `);

        for (const row of compressedChunks) {
            console.log(`  🔓 Chunk ${row.chunk_full_name} for table ${row.table_name} is compressed. Decompressing...`);
            const start = Date.now();
            await prisma.$executeRawUnsafe(`
                SELECT decompress_chunk('${row.chunk_full_name}', if_compressed => true);
            `);
            console.log(`  ✅ Decompressed in ${Date.now() - start}ms.`);
        }
    } catch (error: any) {
        console.warn(`  ⚠️ Warning during chunk decompression: ${error.message}`);
    }
}

async function run() {
    console.log(`🚀 Starting Historical OHLC Backfill (DRY_RUN = ${DRY_RUN})`);
    console.log(`📅 Date range: ${START_DATE} to ${END_DATE}\n`);

    // 1. Fetch all existing instruments and symbols to build cache
    console.log("📥 Loading instruments and symbols from database...");
    const existingInstruments: InstrumentCache[] = await prisma.instrument_lists.findMany({
        where: { exchange: "NSE" },
        select: { id: true, instrument_type: true, upstox_id: true }
    });

    const existingSymbols: SymbolCache[] = await prisma.symbols_list.findMany({
        select: { id: true, instrument_id: true, symbol: true, segment: true, expiry_date: true, strike: true, option_type: true, expiry_month: true }
    });

    console.log(`✅ Loaded ${existingInstruments.length} instruments & ${existingSymbols.length} symbols from DB.`);

    // Build Maps for fast lookup
    const instrumentByUpstoxId = new Map<string, number>();
    const instrumentBySymbol = new Map<string, number>();
    for (const inst of existingInstruments) {
        instrumentBySymbol.set(inst.instrument_type, inst.id);
        if (inst.upstox_id) {
            instrumentByUpstoxId.set(inst.upstox_id, inst.id);
        }
    }

    const symbolByContractName = new Map<string, SymbolCache>();
    for (const sym of existingSymbols) {
        symbolByContractName.set(sym.symbol, sym);
    }

    const dates = generateDates(START_DATE, END_DATE);
    console.log(`📅 Total dates in range: ${dates.length}`);

    let processedDaysCount = 0;
    let skippedDaysCount = 0;
    let missingDaysCount = 0;
    let strikeTypeMismatchCount = 0;

    for (let dateIdx = 0; dateIdx < dates.length; dateIdx++) {
      const dateStr = dates[dateIdx];
      let attempt = 0;
      while (true) {
        try {
        const yyyy = dateStr.substring(0, 4);
        const mm = dateStr.substring(4, 6);
        const dd = dateStr.substring(6, 8);
        const dateFormatted = `${yyyy}-${mm}-${dd}`;
        const targetDateObj = new Date(`${dateFormatted}T00:00:00Z`);

        // Check if we already have records for this date to support resuming
        const [eqCount, futCount, optCount] = await Promise.all([
            prisma.nse_equity.count({ where: { date: targetDateObj } }),
            prisma.nse_futures.count({ where: { date: targetDateObj } }),
            prisma.nse_options.count({ where: { date: targetDateObj } })
        ]);

        // A fully complete day should have a minimum expected number of records:
        // - Equity: > 1500
        // - Futures: > 400
        // - Options: > 8000
        if (!FORCE && eqCount > 1500 && futCount > 400 && optCount > 8000) {
            console.log(`ℹ️ Date ${dateFormatted} already fully backfilled (EQ: ${eqCount}, FUT: ${futCount}, OPT: ${optCount}). Skipping.`);
            skippedDaysCount++;
            break;
        } else if (eqCount > 0 || futCount > 0 || optCount > 0) {
            console.log(`⚠️ Date ${dateFormatted} is partially backfilled (EQ: ${eqCount}, FUT: ${futCount}, OPT: ${optCount}). Will backfill missing records.`);
        }

        const cmUrl = `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${dateStr}_F_0000.csv.zip`;
        const foUrl = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${dateStr}_F_0000.csv.zip`;

        const cmZipPath = path.join(scratchDir, `CM_${dateStr}.zip`);
        const foZipPath = path.join(scratchDir, `FO_${dateStr}.zip`);

        const cmExtractDir = path.join(scratchDir, `CM_${dateStr}`);
        const foExtractDir = path.join(scratchDir, `FO_${dateStr}`);

        console.log(`----------------------------------------`);
        console.log(`🔍 Processing date: ${dateFormatted}`);

        // Try downloading files
        const hasCm = await downloadFile(cmUrl, cmZipPath);
        const hasFo = await downloadFile(foUrl, foZipPath);

        if (!hasCm && !hasFo) {
            console.log(`ℹ️ No Bhavcopy files found for ${dateFormatted} (weekend/holiday). Skipping.`);
            missingDaysCount++;
            break;
        }

        const equityRecords: any[] = [];
        const futuresRecords: any[] = [];
        const optionsRecords: any[] = [];

        // 1. Process CM (Equities)
        if (hasCm) {
            console.log(`  📥 CM Bhavcopy downloaded.`);
            const extractSuccess = extractZip(cmZipPath, cmExtractDir);
            if (extractSuccess) {
                const files = fs.readdirSync(cmExtractDir);
                const csvFile = files.find(f => f.toLowerCase().endsWith(".csv"));
                if (csvFile) {
                    const csvPath = path.join(cmExtractDir, csvFile);
                    await parseCsv(csvPath, (row) => {
                        if (row.SctySrs === "EQ") {
                            const ticker = row.TckrSymb;
                            const isin = row.ISIN;
                            const upstoxId = `NSE_EQ|${isin}`;

                            // Locate instrument list ID
                            let resolvedId = instrumentByUpstoxId.get(upstoxId);
                            if (!resolvedId) {
                                resolvedId = instrumentBySymbol.get(ticker);
                            }

                            if (resolvedId) {
                                const open = parseFloat(row.OpnPric);
                                const high = parseFloat(row.HghPric);
                                const low = parseFloat(row.LwPric);
                                const close = parseFloat(row.ClsPric);

                                // Skip empty/zero lines
                                if (open === 0 && high === 0 && low === 0 && close === 0) return;

                                equityRecords.push({
                                    symbol_id: resolvedId,
                                    symbol: resolvedId.toString(),
                                    date: targetDateObj,
                                    open,
                                    high,
                                    low,
                                    close,
                                    volume: row.TtlTradgVol || "0",
                                    oi: row.OpnIntrst || "0",
                                    exchange: "NSE",
                                });
                            }
                        }
                    });
                }
            }
        }

        // 2. Process FO (Derivatives)
        if (hasFo) {
            console.log(`  📥 FO Bhavcopy downloaded.`);
            const extractSuccess = extractZip(foZipPath, foExtractDir);
            if (extractSuccess) {
                const files = fs.readdirSync(foExtractDir);
                const csvFile = files.find(f => f.toLowerCase().endsWith(".csv"));
                if (csvFile) {
                    const csvPath = path.join(foExtractDir, csvFile);
                    await parseCsv(csvPath, (row) => {
                        const symbolKey = getOptionOrFutureSymbol(row);
                        const sym = symbolByContractName.get(symbolKey) ?? symbolByContractName.get(getOptionOrFutureSymbolNumeric(row));

                        if (sym) {
                            const open = parseFloat(row.OpnPric);
                            const high = parseFloat(row.HghPric);
                            const low = parseFloat(row.LwPric);
                            const close = parseFloat(row.ClsPric);

                            // Skip empty/zero lines
                            if (open === 0 && high === 0 && low === 0 && close === 0) return;

                            if (sym.segment === "FUT") {
                                if (!sym.expiry_date) return;
                                futuresRecords.push({
                                    symbol_id: sym.id.toString(),
                                    symbol: sym.id,
                                    date: targetDateObj,
                                    open,
                                    high,
                                    low,
                                    close,
                                    volume: row.TtlTradgVol || "0",
                                    oi: row.OpnIntrst || "0",
                                    underlying: sym.instrument_id,
                                    expiry_date: sym.expiry_date,
                                });
                            } else if (sym.segment === "OPT") {
                                if (!sym.expiry_date) return;

                                // Bhavcopy's own strike/option_type are ground truth from NSE.
                                // symbols_list.strike/option_type have been found stale/mismatched
                                // on a subset of rows (weekly sync upsert bug, tracked separately) —
                                // trust the row we just downloaded over the cached copy.
                                const bhavStrike = formatStrike(row.StrkPric);
                                const bhavOptionType = row.OptnTp;
                                if (sym.strike !== bhavStrike || sym.option_type !== bhavOptionType) {
                                    strikeTypeMismatchCount++;
                                }

                                optionsRecords.push({
                                    symbol_id: sym.id.toString(),
                                    symbol: sym.id,
                                    date: targetDateObj,
                                    open,
                                    high,
                                    low,
                                    close,
                                    volume: row.TtlTradgVol || "0",
                                    oi: row.OpnIntrst || "0",
                                    underlying: sym.instrument_id,
                                    expiry_date: sym.expiry_date,
                                    strike: bhavStrike,
                                    option_type: bhavOptionType,
                                    expiry_month: sym.expiry_month || "",
                                });
                            }
                        }
                    });
                }
            }
        }

        // 3. Batch insert records
        if (!DRY_RUN) {
            // Check and decompress chunks first
            if (equityRecords.length > 0 || futuresRecords.length > 0 || optionsRecords.length > 0) {
                await decompressChunksForDate(dateFormatted);
            }

            // Bulk insert equity
            if (equityRecords.length > 0) {
                const chunks = chunkArray(equityRecords, 5000);
                let inserted = 0;
                for (const chunk of chunks) {
                    const res = await prisma.nse_equity.createMany({
                        data: chunk,
                        skipDuplicates: true
                    });
                    inserted += res.count;
                }
                console.log(`  💾 Saved ${inserted}/${equityRecords.length} Equity records to DB.`);
            }

            // Bulk insert futures
            if (futuresRecords.length > 0) {
                const chunks = chunkArray(futuresRecords, 5000);
                let inserted = 0;
                for (const chunk of chunks) {
                    const res = await prisma.nse_futures.createMany({
                        data: chunk,
                        skipDuplicates: true
                    });
                    inserted += res.count;
                }
                console.log(`  💾 Saved ${inserted}/${futuresRecords.length} Futures records to DB.`);
            }

            // Bulk insert options
            if (optionsRecords.length > 0) {
                const chunks = chunkArray(optionsRecords, 5000);
                let inserted = 0;
                let chunkIdx = 0;
                for (const chunk of chunks) {
                    chunkIdx++;
                    const res = await prisma.nse_options.createMany({
                        data: chunk,
                        skipDuplicates: true
                    });
                    inserted += res.count;
                    if (chunkIdx % 2 === 0 || chunkIdx === chunks.length) {
                        console.log(`    - Progress: ${chunkIdx}/${chunks.length} options chunks processed (${inserted} rows inserted so far)...`);
                    }
                }
                console.log(`  💾 Saved ${inserted}/${optionsRecords.length} Options records to DB.`);
            }
        } else {
            console.log(`  🚫 [DRY RUN] Would write:`);
            console.log(`     - Equity records: ${equityRecords.length}`);
            console.log(`     - Futures records: ${futuresRecords.length}`);
            console.log(`     - Options records: ${optionsRecords.length}`);
        }

        // 4. Housekeeping: Remove downloaded and extracted files for this day
        try {
            if (fs.existsSync(cmZipPath)) fs.unlinkSync(cmZipPath);
            if (fs.existsSync(foZipPath)) fs.unlinkSync(foZipPath);
            if (fs.existsSync(cmExtractDir)) fs.rmSync(cmExtractDir, { recursive: true, force: true });
            if (fs.existsSync(foExtractDir)) fs.rmSync(foExtractDir, { recursive: true, force: true });
            console.log(`  🧹 Cleaned up temporary files.`);
        } catch (cleanupError: any) {
            console.error(`  ⚠️ Cleanup warning: ${cleanupError.message}`);
        }

        processedDaysCount++;

        // Pause briefly to be polite to the NSE archive server
        await new Promise(resolve => setTimeout(resolve, 500));
        break; // date succeeded, move to next date
        } catch (err: any) {
          const transient = err?.code === "P1001" || err?.code === "P1017" || /Server has closed the connection|Can't reach database server/.test(err?.message || "");
          attempt++;
          if (!transient || attempt > 3) {
            throw err;
          }
          console.error(`  ⚠️ Transient DB error on ${dateStr} (attempt ${attempt}/3): ${err.message}. Reconnecting and retrying...`);
          await prisma.$disconnect().catch(() => {});
          await new Promise(resolve => setTimeout(resolve, 3000 * attempt));
          await prisma.$connect().catch(() => {});
        }
      }
    }

    console.log(`\n========================================`);
    console.log(`📊 EXECUTION SUMMARY:`);
    console.log(`----------------------------------------`);
    console.log(`✅ Processed Trading Days: ${processedDaysCount}`);
    console.log(`ℹ️ Skipped Days (Already in DB): ${skippedDaysCount}`);
    console.log(`ℹ️ Missing Days (Weekend/Holiday): ${missingDaysCount}`);
    console.log(`⚠️ symbols_list strike/option_type mismatches found (corrected using Bhavcopy, not fixed at source): ${strikeTypeMismatchCount}`);
    console.log(`========================================\n`);

    await prisma.$disconnect();
    console.log("🏁 Process complete.");
}

run().catch(async (e) => {
    console.error("💥 Critical Execution Failure:", e);
    await prisma.$disconnect();
    process.exit(1);
});
