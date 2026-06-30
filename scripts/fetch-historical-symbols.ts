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

// Flag to prevent database mutations
const DRY_RUN = false;

// Date range config
const START_DATE = "2026-06-20";
const END_DATE = new Date().toISOString().split("T")[0];

// Paths
const scratchDir = path.resolve(__dirname, "../scratch/temp_bhavcopy");

// Utility to create directory if not exists
if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}

// Generate date strings between two dates
function generateDates(start: string, end: string): string[] {
    const dates: string[] = [];
    let current = new Date(start);
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

// Download a file
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
            timeout: 10000
        });

        const writer = fs.createWriteStream(destPath);
        response.data.pipe(writer);

        await new Promise<void>((resolve, reject) => {
            writer.on("finish", () => resolve());
            writer.on("error", (err) => reject(err));
        });
        return true;
    } catch (error: any) {
        return false;
    }
}

// Extract zip using PowerShell
function extractZip(zipPath: string, destDir: string): boolean {
    try {
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`);
        return true;
    } catch (error: any) {
        console.error(`❌ Extraction error: ${error.message}`);
        return false;
    }
}

// Parse CSV file line by line
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

// Format strike price to slice off unnecessary decimals
function formatStrike(strikeStr: string): string {
    const num = parseFloat(strikeStr);
    if (isNaN(num)) return strikeStr;
    if (num % 1 === 0) {
        return num.toString();
    }
    return num.toString(); // Keep decimal if floating (e.g. 257.5)
}

// Fallback symbol generator for Options and Futures
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

// Main execution function
async function run() {
    console.log(`🚀 Starting Historical Symbols Sync (DRY_RUN = ${DRY_RUN})`);
    console.log(`📅 Date range: ${START_DATE} to ${END_DATE}\n`);

    // 1. Fetch all existing instruments and symbols to build cache
    console.log("📥 Loading existing instruments and symbols from database...");
    const existingInstruments = await prisma.instrument_lists.findMany({
        where: { exchange: "NSE" },
        select: { id: true, instrument_type: true, upstox_id: true }
    });

    const existingSymbols = await prisma.symbols_list.findMany({
        select: { id: true, instrument_id: true, symbol: true, upstox_id: true }
    });

    console.log(`✅ Loaded ${existingInstruments.length} instruments & ${existingSymbols.length} symbols from DB.`);

    // Build Maps for O(1) checks
    const instrumentMap = new Map<string, number>(); // type -> DB id
    const instrumentUpstoxMap = new Map<string, number>(); // upstox_id -> DB id
    for (const inst of existingInstruments) {
        instrumentMap.set(inst.instrument_type, inst.id);
        if (inst.upstox_id) {
            instrumentUpstoxMap.set(inst.upstox_id, inst.id);
        }
    }

    const symbolSet = new Set<string>(); // instrumentId_symbol
    const symbolUpstoxSet = new Set<string>(); // upstox_id
    for (const sym of existingSymbols) {
        symbolSet.add(`${sym.instrument_id}_${sym.symbol}`);
        if (sym.upstox_id) {
            symbolUpstoxSet.add(sym.upstox_id);
        }
    }

    const dates = generateDates(START_DATE, END_DATE);
    console.log(`📅 Total dates to check: ${dates.length}`);

    // Track statistics
    let processedDays = 0;
    let missingDays = 0;
    let newInstrumentsParsedCount = 0;
    let newSymbolsParsedCount = 0;

    // Temporary caches to prevent double insertion within the script run
    const pendingInstruments = new Map<string, { exchange: string, instrument_type: string, upstox_id: string, upstox_symbol: string }>();
    const pendingSymbols = new Map<string, { instrument_type: string, symbol: string, segment: string, expiry_date: Date, strike: string, option_type: string, expiry_month: string, upstox_id: string, upstox_symbol: string }>();

    let nextMockInstrumentId = 9999000;

    for (const dateStr of dates) {
        const yyyy = dateStr.substring(0, 4);
        const mm = dateStr.substring(4, 6);
        const dd = dateStr.substring(6, 8);
        const dateFormatted = `${yyyy}-${mm}-${dd}`;

        const cmUrl = `https://nsearchives.nseindia.com/content/cm/BhavCopy_NSE_CM_0_0_0_${dateStr}_F_0000.csv.zip`;
        const foUrl = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${dateStr}_F_0000.csv.zip`;

        const cmZipPath = path.join(scratchDir, `CM_${dateStr}.zip`);
        const foZipPath = path.join(scratchDir, `FO_${dateStr}.zip`);

        const cmExtractDir = path.join(scratchDir, `CM_${dateStr}`);
        const foExtractDir = path.join(scratchDir, `FO_${dateStr}`);

        console.log(`----------------------------------------`);
        console.log(`🔍 Checking date: ${dateFormatted}`);

        // Try downloading CM Bhavcopy
        let hasCm = await downloadFile(cmUrl, cmZipPath);
        let hasFo = await downloadFile(foUrl, foZipPath);

        if (!hasCm && !hasFo) {
            // Probably a weekend or holiday
            console.log(`ℹ️ No files found for ${dateFormatted} (weekend/holiday). Skipping.`);
            missingDays++;
            continue;
        }

        processedDays++;

        // Process CM (Equities)
        if (hasCm) {
            console.log(`📥 CM Bhavcopy downloaded successfully.`);
            const extractSuccess = extractZip(cmZipPath, cmExtractDir);
            if (extractSuccess) {
                const files = fs.readdirSync(cmExtractDir);
                const csvFile = files.find(f => f.toLowerCase().endsWith(".csv"));
                if (csvFile) {
                    const csvPath = path.join(cmExtractDir, csvFile);
                    await parseCsv(csvPath, (row) => {
                        // We only want standard equities (SctySrs = "EQ")
                        if (row.SctySrs === "EQ") {
                            const ticker = row.TckrSymb;
                            const isin = row.ISIN;
                            const upstoxId = `NSE_EQ|${isin}`;

                            // Check if instrument is already in DB or pending cache
                            const exists = instrumentMap.has(ticker) || instrumentUpstoxMap.has(upstoxId) || pendingInstruments.has(ticker);
                            if (!exists) {
                                pendingInstruments.set(ticker, {
                                    exchange: "NSE",
                                    instrument_type: ticker,
                                    upstox_id: upstoxId,
                                    upstox_symbol: ticker
                                });
                                newInstrumentsParsedCount++;
                                console.log(`✨ Found new EQ Instrument: ${ticker} (ISIN: ${isin})`);
                            }
                        }
                    });
                }
            }
        }

        // Process FO (Derivatives)
        if (hasFo) {
            console.log(`📥 FO Bhavcopy downloaded successfully.`);
            const extractSuccess = extractZip(foZipPath, foExtractDir);
            if (extractSuccess) {
                const files = fs.readdirSync(foExtractDir);
                const csvFile = files.find(f => f.toLowerCase().endsWith(".csv"));
                if (csvFile) {
                    const csvPath = path.join(foExtractDir, csvFile);
                    await parseCsv(csvPath, (row) => {
                        const ticker = row.TckrSymb;
                        const symbol = getOptionOrFutureSymbol(row);
                        const instId = row.FinInstrmId;
                        const upstoxId = `NSE_FO|${instId}`;

                        // Ensure underlying instrument exists in map or pending. If not, add it.
                        // For futures/options, the underlying is the ticker (e.g. RELIANCE, NIFTY)
                        const existsUnderlying = instrumentMap.has(ticker) || pendingInstruments.has(ticker);
                        if (!existsUnderlying) {
                            pendingInstruments.set(ticker, {
                                exchange: "NSE",
                                instrument_type: ticker,
                                upstox_id: `NSE_EQ|${ticker}`, // Mock/Placeholder upstox_id for derivative underlyings if not found in EQ
                                upstox_symbol: ticker
                            });
                            newInstrumentsParsedCount++;
                            console.log(`✨ Found new Underlying Instrument: ${ticker}`);
                        }

                        // Determine Segment
                        const optType = row.OptnTp;
                        const segment = (!optType || optType === "XX" || optType === "") ? "FUT" : "OPT";

                        // Check if symbol already exists in DB or pending cache
                        // Resolve the instrument ID
                        let resolvedInstId = instrumentMap.get(ticker);
                        if (!resolvedInstId) {
                            // If in dry-run, create mock ID for reference
                            resolvedInstId = nextMockInstrumentId++;
                            instrumentMap.set(ticker, resolvedInstId);
                        }

                        const uniqueKey = `${resolvedInstId}_${symbol}`;
                        const existsSymbol = symbolSet.has(uniqueKey) || pendingSymbols.has(symbol);

                        if (!existsSymbol) {
                            const expiryDate = new Date(`${row.XpryDt}T00:00:00Z`);
                            const expiryMonth = expiryDate.toLocaleString("default", { month: "long", timeZone: "UTC" }).toUpperCase();
                            const strikeStr = segment === "FUT" ? "0" : formatStrike(row.StrkPric);
                            const finalOptType = segment === "FUT" ? "" : optType;

                            pendingSymbols.set(symbol, {
                                instrument_type: ticker,
                                symbol: symbol,
                                segment: segment,
                                expiry_date: expiryDate,
                                strike: strikeStr,
                                option_type: finalOptType,
                                expiry_month: expiryMonth,
                                upstox_id: upstoxId,
                                upstox_symbol: symbol
                            });
                            newSymbolsParsedCount++;
                        }
                    });
                }
            }
        }

        // Clean up downloaded/extracted files for this date immediately to conserve disk space
        try {
            if (fs.existsSync(cmZipPath)) fs.unlinkSync(cmZipPath);
            if (fs.existsSync(foZipPath)) fs.unlinkSync(foZipPath);
            if (fs.existsSync(cmExtractDir)) fs.rmSync(cmExtractDir, { recursive: true, force: true });
            if (fs.existsSync(foExtractDir)) fs.rmSync(foExtractDir, { recursive: true, force: true });
            console.log(`🧹 Cleaned up temporary files for ${dateFormatted}`);
        } catch (cleanupError: any) {
            console.error(`⚠️ Cleanup warning: ${cleanupError.message}`);
        }

        // Delay to be polite to NSE server
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log(`\n========================================`);
    console.log(`📊 PARSING SUMMARY:`);
    console.log(`----------------------------------------`);
    console.log(`✅ Processed Trading Days: ${processedDays}`);
    console.log(`ℹ️ Skipped Days (Holidays/Weekends): ${missingDays}`);
    console.log(`✨ New Instruments Discovered: ${pendingInstruments.size}`);
    console.log(`✨ New Symbols Discovered: ${pendingSymbols.size}`);
    console.log(`========================================\n`);

    if (DRY_RUN) {
        console.log(`🚫 DRY RUN MODE ENABLED. No changes were written to the database.`);
        console.log(`Samples of new instruments to insert:`);
        const instSamples = Array.from(pendingInstruments.values()).slice(0, 5);
        instSamples.forEach(inst => console.log(`  - Exchange: ${inst.exchange}, Type: ${inst.instrument_type}, Upstox ID: ${inst.upstox_id}`));

        console.log(`\nSamples of new symbols to insert:`);
        const symSamples = Array.from(pendingSymbols.values()).slice(0, 5);
        symSamples.forEach(sym => console.log(`  - Symbol: ${sym.symbol}, Segment: ${sym.segment}, Expiry: ${sym.expiry_date.toISOString().split('T')[0]}, Strike: ${sym.strike}, Type: ${sym.option_type}`));
    } else {
        console.log(`💾 Writing changes to the database...`);

        // 1. Write new instruments
        if (pendingInstruments.size > 0) {
            console.log(`Inserting ${pendingInstruments.size} new instruments...`);
            const instArray = Array.from(pendingInstruments.values());
            
            // We insert instruments sequentially to make sure we get real IDs back and avoid conflicts
            for (const inst of instArray) {
                try {
                    const result = await prisma.instrument_lists.upsert({
                        where: {
                            exchange_instrument_type: {
                                exchange: inst.exchange,
                                instrument_type: inst.instrument_type
                            }
                        },
                        update: {
                            upstox_id: inst.upstox_id,
                            upstox_symbol: inst.upstox_symbol
                        },
                        create: {
                            exchange: inst.exchange,
                            instrument_type: inst.instrument_type,
                            upstox_id: inst.upstox_id,
                            upstox_symbol: inst.upstox_symbol
                        },
                        select: { id: true }
                    });
                    instrumentMap.set(inst.instrument_type, result.id);
                } catch (e: any) {
                    console.error(`❌ Failed to insert instrument ${inst.instrument_type}: ${e.message}`);
                }
            }
            console.log(`✅ Instruments insertion complete.`);
        }

        // 2. Write new symbols in chunks
        if (pendingSymbols.size > 0) {
            console.log(`Inserting ${pendingSymbols.size} new symbols...`);
            const symArray = Array.from(pendingSymbols.values());
            
            const symbolsToInsert: any[] = [];
            for (const sym of symArray) {
                const resolvedInstId = instrumentMap.get(sym.instrument_type);
                if (resolvedInstId) {
                    symbolsToInsert.push({
                        instrument_id: resolvedInstId,
                        symbol: sym.symbol,
                        segment: sym.segment,
                        expiry_date: sym.expiry_date,
                        strike: sym.strike,
                        option_type: sym.option_type,
                        expiry_month: sym.expiry_month,
                        upstox_id: sym.upstox_id,
                        upstox_symbol: sym.upstox_symbol
                    });
                }
            }

            // Chunk inserts (1000 records at a time)
            const chunkSize = 1000;
            let insertedCount = 0;
            for (let i = 0; i < symbolsToInsert.length; i += chunkSize) {
                const chunk = symbolsToInsert.slice(i, i + chunkSize);
                const result = await prisma.symbols_list.createMany({
                    data: chunk,
                    skipDuplicates: true
                });
                insertedCount += result.count;
                console.log(`  Processed symbols chunk ${Math.min(i + chunkSize, symbolsToInsert.length)}/${symbolsToInsert.length} (Inserted: ${result.count})`);
            }
            console.log(`✅ Symbols insertion complete. Total symbols written: ${insertedCount}`);
        }
    }

    // Disconnect Prisma
    await prisma.$disconnect();
    console.log(`\n🏁 Process complete.`);
}

run().catch(async (e) => {
    console.error(`💥 Critical Execution Failure:`, e);
    await prisma.$disconnect();
    process.exit(1);
});
