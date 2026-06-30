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

const START_DATE = "2026-01-01";
const END_DATE = new Date().toISOString().split("T")[0];

const scratchDir = path.resolve(__dirname, "../scratch/temp_repair_bhavcopy");

if (!fs.existsSync(scratchDir)) {
    fs.mkdirSync(scratchDir, { recursive: true });
}

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
    } catch {
        return false;
    }
}

function extractZip(zipPath: string, destDir: string): boolean {
    try {
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        execSync(`powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`, { stdio: "ignore" });
        return true;
    } catch {
        return false;
    }
}

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

function formatStrike(strikeStr: string): string {
    const num = parseFloat(strikeStr);
    if (isNaN(num)) return strikeStr;
    return String(Math.round(num));
}

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

async function run() {
    console.log("🛠️ Starting Symbols Repair Script...");
    
    // 1. Load active instruments
    console.log("📥 Loading instruments and symbols from DB...");
    const instruments = await prisma.instrument_lists.findMany({
        where: { exchange: "NSE" },
        select: { id: true, instrument_type: true }
    });
    
    const instrumentMap = new Map<string, number>();
    for (const inst of instruments) {
        instrumentMap.set(inst.instrument_type, inst.id);
    }

    // 2. Load existing symbols to memory to identify what needs correction
    const dbSymbols = await prisma.symbols_list.findMany({
        select: {
            id: true,
            instrument_id: true,
            symbol: true,
            upstox_id: true,
            upstox_symbol: true,
            expiry_date: true,
            expiry_month: true
        }
    });

    const dbSymbolMap = new Map<string, typeof dbSymbols[0]>(); // key: instrumentId_symbol
    for (const sym of dbSymbols) {
        dbSymbolMap.set(`${sym.instrument_id}_${sym.symbol}`, sym);
    }

    console.log(`✅ Loaded ${instrumentMap.size} instruments and ${dbSymbolMap.size} symbols from DB.`);

    const dates = generateDates(START_DATE, END_DATE);
    console.log(`📅 Total dates to scan for corrections: ${dates.length}`);

    // Use Map to prevent duplicates
    const updatesPending = new Map<number, {
        id: number;
        upstox_id: string;
        upstox_symbol: string;
        expiry_date: Date;
        expiry_month: string;
    }>();

    for (let d = 0; d < dates.length; d++) {
        const dateStr = dates[d];
        const dateFormatted = `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`;
        
        // Exact same URLs as fetch-historical-symbols.ts
        const foUrl = `https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_${dateStr}_F_0000.csv.zip`;
        const foZipPath = path.join(scratchDir, `FO_${dateStr}.zip`);
        const foExtractDir = path.join(scratchDir, `FO_${dateStr}`);

        // Try downloading
        const hasFo = await downloadFile(foUrl, foZipPath);
        if (!hasFo) {
            continue;
        }

        const extractSuccess = extractZip(foZipPath, foExtractDir);
        if (extractSuccess) {
            const files = fs.readdirSync(foExtractDir);
            const csvFile = files.find(f => f.toLowerCase().endsWith(".csv"));
            if (csvFile) {
                const csvPath = path.join(foExtractDir, csvFile);
                await parseCsv(csvPath, (row) => {
                    const ticker = row.TckrSymb;
                    const instId = row.FinInstrmId;
                    if (!ticker || !instId) return;

                    const resolvedInstId = instrumentMap.get(ticker);
                    if (!resolvedInstId) return;

                    const symbol = getOptionOrFutureSymbol(row);
                    const uniqueKey = `${resolvedInstId}_${symbol}`;

                    const dbSym = dbSymbolMap.get(uniqueKey);
                    if (dbSym) {
                        const upstoxId = `NSE_FO|${instId}`;
                        const expiryDate = new Date(`${row.XpryDt}T00:00:00Z`);
                        const expiryMonth = expiryDate.toLocaleString("default", { month: "long", timeZone: "UTC" }).toUpperCase();

                        // Check if fields mismatch
                        const dbExpiryTime = dbSym.expiry_date ? new Date(dbSym.expiry_date).getTime() : 0;
                        const bhavExpiryTime = expiryDate.getTime();

                        if (
                            dbSym.upstox_id !== upstoxId ||
                            dbSym.upstox_symbol !== symbol ||
                            dbExpiryTime !== bhavExpiryTime ||
                            dbSym.expiry_month !== expiryMonth
                        ) {
                            updatesPending.set(dbSym.id, {
                                id: dbSym.id,
                                upstox_id: upstoxId,
                                upstox_symbol: symbol,
                                expiry_date: expiryDate,
                                expiry_month: expiryMonth
                            });
                            
                            // Update local map to prevent duplicate checks
                            dbSym.upstox_id = upstoxId;
                            dbSym.upstox_symbol = symbol;
                            dbSym.expiry_date = expiryDate;
                            dbSym.expiry_month = expiryMonth;
                        }
                    }
                });
            }
        }

        // Clean up immediately
        try {
            if (fs.existsSync(foZipPath)) fs.unlinkSync(foZipPath);
            if (fs.existsSync(foExtractDir)) fs.rmSync(foExtractDir, { recursive: true, force: true });
        } catch {}
    }

    const updatesList = Array.from(updatesPending.values());
    console.log(`\n🔍 Found ${updatesList.length} unique records that require repair.`);

    if (updatesList.length > 0) {
        console.log(`💾 Creating temp table for fast update...`);
        
        await prisma.$transaction(async (tx) => {
            // 1. Create temp table
            await tx.$executeRawUnsafe(`
                CREATE TEMP TABLE temp_repair_symbols (
                    id INT PRIMARY KEY,
                    upstox_id TEXT,
                    upstox_symbol TEXT,
                    expiry_date TIMESTAMP,
                    expiry_month TEXT
                ) ON COMMIT DROP;
            `);

            // 2. Insert records into temp table in chunks
            const chunkSize = 2000;
            let inserted = 0;
            for (let i = 0; i < updatesList.length; i += chunkSize) {
                const chunk = updatesList.slice(i, i + chunkSize);
                
                const valueClauses: string[] = [];
                const params: any[] = [];
                let paramIdx = 1;

                for (const item of chunk) {
                    valueClauses.push(`($${paramIdx}::int, $${paramIdx+1}::text, $${paramIdx+2}::text, $${paramIdx+3}::timestamp, $${paramIdx+4}::text)`);
                    params.push(item.id, item.upstox_id, item.upstox_symbol, item.expiry_date, item.expiry_month);
                    paramIdx += 5;
                }

                const insertQuery = `
                    INSERT INTO temp_repair_symbols (id, upstox_id, upstox_symbol, expiry_date, expiry_month)
                    VALUES ${valueClauses.join(", ")};
                `;
                
                await tx.$executeRawUnsafe(insertQuery, ...params);
                inserted += chunk.length;
                console.log(`  Temp table: Inserted ${inserted}/${updatesList.length} records.`);
            }

            // 3. Perform the bulk update via JOIN
            console.log(`  Applying updates to market_data.symbols_list from temp table...`);
            await tx.$executeRawUnsafe(`
                UPDATE market_data.symbols_list AS s
                SET 
                  upstox_id = t.upstox_id,
                  upstox_symbol = t.upstox_symbol,
                  expiry_date = t.expiry_date,
                  expiry_month = t.expiry_month,
                  updated_at = NOW()
                FROM temp_repair_symbols t
                WHERE s.id = t.id;
            `);
            console.log(`✅ Bulk update executed successfully.`);
        });
        
        console.log(`✅ Repair complete! Total records corrected: ${updatesList.length}`);
    } else {
        console.log("✅ No corrupted records found. Everything is already correct!");
    }

    await prisma.$disconnect();
    
    // Final clean up of directory
    try {
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    } catch {}
    
    console.log("🏁 Process complete.");
}

run().catch(async (e) => {
    console.error("💥 Repair script failed:", e);
    await prisma.$disconnect();
    try {
        if (fs.existsSync(scratchDir)) {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
    } catch {}
    process.exit(1);
});
