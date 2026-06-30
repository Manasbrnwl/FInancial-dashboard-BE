import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { upstoxOhlcService, OhlcQuote } from "../services/upstoxOhlcService";
import { sendEmailNotification } from "../utils/sendEmail";
import { loadEnv } from "../config/env";
import { devLog, devError } from "../utils/errorLogger";

loadEnv();
const prisma = new PrismaClient();

// Batch size for Upstox Quote API
const BATCH_SIZE = 500;

interface InstrumentData {
    id: number;
    instrument_type: string;
    upstox_id: string;
    upstox_symbol?: string | null;
}

interface SymbolData {
    id: number;
    instrument_id: number;
    symbol: string;
    segment: string;
    expiry_date: Date | null;
    upstox_id: string;
    strike: string | null;
    option_type: string | null;
    expiry_month: string | null;
}

/**
 * Fetch active NSE Equity instruments from instrument_lists with valid Upstox IDs.
 */
async function getActiveEquityInstruments(): Promise<InstrumentData[]> {
    try {
        const instruments = await prisma.instrument_lists.findMany({
            where: {
                exchange: "NSE",
                upstox_id: { not: null },
                OR: [
                    { upstox_id: { startsWith: "NSE_EQ" } },
                    { upstox_id: { startsWith: "NSE_INDEX" } }
                ]
            },
            select: {
                id: true,
                instrument_type: true,
                upstox_id: true,
                upstox_symbol: true,
            },
        });

        return instruments.map((s) => ({
            id: s.id,
            instrument_type: s.instrument_type,
            upstox_id: s.upstox_id!,
            upstox_symbol: s.upstox_symbol,
        }));
    } catch (error: any) {
        devError("❌ Failed to fetch active equity instruments from DB:", error.message);
        return [];
    }
}

/**
 * Fetch active NSE Futures symbols from symbols_list with valid Upstox IDs.
 */
async function getActiveFuturesSymbols(): Promise<SymbolData[]> {
    try {
        const symbols = await prisma.symbols_list.findMany({
            where: {
                segment: "FUT",
                upstox_id: {
                    not: null,
                },
                expiry_date: {
                    gte: new Date(),
                },
            },
            select: {
                id: true,
                instrument_id: true,
                symbol: true,
                segment: true,
                expiry_date: true,
                upstox_id: true,
                strike: true,
                option_type: true,
                expiry_month: true,
            },
        });

        return symbols.map((s) => ({
            id: s.id,
            instrument_id: s.instrument_id,
            symbol: s.symbol,
            segment: s.segment || "FUT",
            expiry_date: s.expiry_date,
            upstox_id: s.upstox_id!,
            strike: s.strike,
            option_type: s.option_type,
            expiry_month: s.expiry_month,
        }));
    } catch (error: any) {
        devError("❌ Failed to fetch active futures symbols from DB:", error.message);
        return [];
    }
}

/**
 * Fetch active NSE Options symbols from symbols_list with valid Upstox IDs.
 */
async function getActiveOptionsSymbols(): Promise<SymbolData[]> {
    try {
        const symbols = await prisma.symbols_list.findMany({
            where: {
                segment: "OPT",
                upstox_id: {
                    not: null,
                },
                expiry_date: {
                    gte: new Date(),
                },
            },
            select: {
                id: true,
                instrument_id: true,
                symbol: true,
                segment: true,
                expiry_date: true,
                upstox_id: true,
                strike: true,
                option_type: true,
                expiry_month: true,
            },
        });

        return symbols.map((s) => ({
            id: s.id,
            instrument_id: s.instrument_id,
            symbol: s.symbol,
            segment: s.segment || "OPT",
            expiry_date: s.expiry_date,
            upstox_id: s.upstox_id!,
            strike: s.strike,
            option_type: s.option_type,
            expiry_month: s.expiry_month,
        }));
    } catch (error: any) {
        devError("❌ Failed to fetch active options symbols from DB:", error.message);
        return [];
    }
}

/**
 * Function to send email notification for daily job
 */
async function sendDailyJobEmail(
    status: "started" | "completed" | "failed",
    details: {
        equityCount?: number;
        futuresCount?: number;
        optionsCount?: number;
        totalRecordsInserted?: number;
        errorMessage?: string;
    }
): Promise<void> {
    try {
        const date = new Date();
        const timeString = date.toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour12: true,
        });

        let subject: string;
        let textContent: string;
        let htmlContent: string;

        switch (status) {
            case "started":
                subject = "📈 Daily NSE OHLC Upstox Job Started";
                textContent = `Daily NSE OHLC job (Upstox V3) started at ${timeString}`;
                htmlContent = `
          <h2>📈 Daily NSE OHLC Upstox Job Started</h2>
          <p><strong>Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> Job initialization successful</p>
          <p>Fetching OHLC data via Upstox V3 API...</p>
        `;
                break;

            case "completed":
                subject = "✅ Daily NSE OHLC Upstox Job Completed";
                textContent = `Daily NSE OHLC job completed successfully at ${timeString}.
        Equity records: ${details.equityCount || 0}
        Futures records: ${details.futuresCount || 0}
        Options records: ${details.optionsCount || 0}
        Total inserted: ${details.totalRecordsInserted || 0}`;
                htmlContent = `
          <h2>✅ Daily NSE OHLC Upstox Job Completed</h2>
          <p><strong>Completion Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ✅ Success</p>
          <hr>
          <h3>📈 Results Summary:</h3>
          <ul>
            <li><strong>Equity Records:</strong> ${details.equityCount || 0}</li>
            <li><strong>Futures Records:</strong> ${details.futuresCount || 0}</li>
            <li><strong>Options Records:</strong> ${details.optionsCount || 0}</li>
            <li><strong>Total Inserted:</strong> ${details.totalRecordsInserted || 0}</li>
          </ul>
          <p><em>Data successfully stored in nse_equity, nse_futures, nse_options tables.</em></p>
        `;
                break;

            case "failed":
                subject = "❌ Daily NSE OHLC Upstox Job Failed";
                textContent = `Daily NSE OHLC job failed at ${timeString}. Error: ${details.errorMessage}`;
                htmlContent = `
          <h2>❌ Daily NSE OHLC Upstox Job Failed</h2>
          <p><strong>Failure Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ❌ Failed</p>
          <hr>
          <h3>🚨 Error Details:</h3>
          <p><strong>Error Message:</strong> ${details.errorMessage || "Unknown error"}</p>
          <p><em>Please check the application logs for detailed information.</em></p>
        `;
                break;
        }

        await sendEmailNotification(
            process.env.RECEIVER_EMAIL || "mystmanas@gmail.com",
            subject,
            textContent,
            htmlContent
        );

        if (process.env.NODE_ENV === "development") {
            devLog(`📧 Email notification sent: ${status}`);
        }
    } catch (error: any) {
        devError(`❌ Failed to send email notification:`, error.message);
    }
}

/**
 * Process NSE Equity OHLC data
 */
async function processEquityOhlc(
    instruments: InstrumentData[],
    token: string,
    today: Date
): Promise<number> {
    if (instruments.length === 0) return 0;

    let totalInserted = 0;
    const upstoxKeys = instruments.map(inst => inst.upstox_id);

    devLog(`📊 Processing ${instruments.length} NSE Equity instruments...`);

    const ohlcData = await upstoxOhlcService.fetchOhlcBatched(
        upstoxKeys,
        token,
        "1d",
        (batchIndex, totalBatches) => {
            if (process.env.NODE_ENV === "development") {
                devLog(`✅ Equity OHLC batch ${batchIndex}/${totalBatches} completed`);
            }
        }
    );

    const equityRecords = [];
    for (const inst of instruments) {
        const prefix = inst.upstox_id.split("|")[0];
        const symbolKey = inst.upstox_symbol || inst.instrument_type;
        const lookupKey = `${prefix}:${symbolKey}`;
        const quote = ohlcData[lookupKey] as OhlcQuote | undefined;

        if (!quote) continue;

        const ohlc = upstoxOhlcService.extractDailyOhlc(quote);
        if (!ohlc) continue;

        // Skip records with zero OHLC values
        if (ohlc.open === 0 && ohlc.high === 0 && ohlc.low === 0 && ohlc.close === 0) continue;

        equityRecords.push({
            symbol_id: inst.id,
            symbol: inst.id.toString(),
            date: today,
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            volume: ohlc.volume.toString(),
            oi: "0",
            exchange: "NSE",
        });
    }

    if (equityRecords.length > 0) {
        const result = await prisma.nse_equity.createMany({
            data: equityRecords,
            skipDuplicates: true,
        });
        totalInserted = result.count;
    }

    devLog(`✅ NSE Equity: ${totalInserted} records inserted`);
    return totalInserted;
}

/**
 * Process NSE Futures OHLC data
 */
async function processFuturesOhlc(
    symbols: SymbolData[],
    token: string,
    today: Date
): Promise<number> {
    if (symbols.length === 0) return 0;

    let totalInserted = 0;
    const upstoxKeys = symbols.map(sym => sym.upstox_id);

    devLog(`📊 Processing ${symbols.length} NSE Futures symbols...`);

    const ohlcData = await upstoxOhlcService.fetchOhlcBatched(
        upstoxKeys,
        token,
        "1d",
        (batchIndex, totalBatches) => {
            if (process.env.NODE_ENV === "development") {
                devLog(`✅ Futures OHLC batch ${batchIndex}/${totalBatches} completed`);
            }
        }
    );

    const futuresRecords = [];
    for (const sym of symbols) {
        // Response key format: NSE_FO:SYMBOL
        const lookupKey = `NSE_FO:${sym.symbol}`;
        const quote = ohlcData[lookupKey] as OhlcQuote | undefined;

        if (!quote) continue;

        const ohlc = upstoxOhlcService.extractDailyOhlc(quote);
        if (!ohlc) continue;

        // Skip records with zero OHLC values
        if (ohlc.open === 0 && ohlc.high === 0 && ohlc.low === 0 && ohlc.close === 0) continue;

        futuresRecords.push({
            symbol_id: sym.id.toString(),
            symbol: sym.id,
            date: today,
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            volume: ohlc.volume.toString(),
            oi: "0",
            underlying: sym.instrument_id,
            expiry_date: sym.expiry_date,
        });
    }

    if (futuresRecords.length > 0) {
        const result = await prisma.nse_futures.createMany({
            data: futuresRecords,
            skipDuplicates: true,
        });
        totalInserted = result.count;
    }

    devLog(`✅ NSE Futures: ${totalInserted} records inserted`);
    return totalInserted;
}

/**
 * Process NSE Options OHLC data
 */
async function processOptionsOhlc(
    symbols: SymbolData[],
    token: string,
    today: Date
): Promise<number> {
    if (symbols.length === 0) return 0;

    let totalInserted = 0;
    const upstoxKeys = symbols.map(sym => sym.upstox_id);

    devLog(`📊 Processing ${symbols.length} NSE Options symbols...`);

    const ohlcData = await upstoxOhlcService.fetchOhlcBatched(
        upstoxKeys,
        token,
        "1d",
        (batchIndex, totalBatches) => {
            if (process.env.NODE_ENV === "development") {
                devLog(`✅ Options OHLC batch ${batchIndex}/${totalBatches} completed`);
            }
        }
    );

    const optionsRecords = [];
    for (const sym of symbols) {
        // Response key format: NSE_FO:SYMBOL
        const lookupKey = `NSE_FO:${sym.symbol}`;
        const quote = ohlcData[lookupKey] as OhlcQuote | undefined;

        if (!quote) continue;

        const ohlc = upstoxOhlcService.extractDailyOhlc(quote);
        if (!ohlc) continue;

        // Skip records with zero OHLC values
        if (ohlc.open === 0 && ohlc.high === 0 && ohlc.low === 0 && ohlc.close === 0) continue;

        optionsRecords.push({
            symbol_id: sym.id.toString(),
            symbol: sym.id,
            date: today,
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            volume: ohlc.volume.toString(),
            oi: "0",
            underlying: sym.instrument_id,
            expiry_date: sym.expiry_date,
            strike: sym.strike,
            option_type: sym.option_type,
            expiry_month: sym.expiry_month,
        });
    }

    if (optionsRecords.length > 0) {
        const result = await prisma.nse_options.createMany({
            data: optionsRecords,
            skipDuplicates: true,
        });
        totalInserted = result.count;
    }

    devLog(`✅ NSE Options: ${totalInserted} records inserted`);
    return totalInserted;
}

/**
 * Main execution function for the daily OHLC job
 */
export async function executeDailyOhlcUpstoxJob(): Promise<void> {
    const startTime = Date.now();
    devLog(`🕐 Starting Daily NSE OHLC Upstox Job at ${new Date().toISOString()}`);

    try {
        // Send start notification
        // await sendDailyJobEmail("started", {});

        // 1. Get Access Token
        const token = await upstoxAuthService.getAccessToken();
        if (!token) {
            devError("❌ No Upstox Access Token available. Skipping job.");
            await sendDailyJobEmail("failed", { errorMessage: "No Upstox Access Token available" });
            return;
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // 2. Get Active Instruments and Symbols
        const [equityInstruments, futuresSymbols, optionsSymbols] = await Promise.all([
            getActiveEquityInstruments(),
            getActiveFuturesSymbols(),
            getActiveOptionsSymbols(),
        ]);

        devLog(`📊 Found: ${equityInstruments.length} equity, ${futuresSymbols.length} futures, ${optionsSymbols.length} options`);

        // 3. Process each segment
        const equityCount = await processEquityOhlc(equityInstruments, token, today);
        const futuresCount = await processFuturesOhlc(futuresSymbols, token, today);
        const optionsCount = await processOptionsOhlc(optionsSymbols, token, today);

        const totalInserted = equityCount + futuresCount + optionsCount;
        const duration = (Date.now() - startTime) / 1000;

        devLog(`✅ Daily OHLC Job Completed. Total: ${totalInserted} records in ${duration.toFixed(2)}s`);

        // Send completion notification
        await sendDailyJobEmail("completed", {
            equityCount,
            futuresCount,
            optionsCount,
            totalRecordsInserted: totalInserted,
        });

    } catch (error: any) {
        devError("❌ Critical Error in Daily OHLC Job:", error.message);
        await sendDailyJobEmail("failed", { errorMessage: error.message });
    }
}

/**
 * Initialize the daily OHLC job with Upstox
 * Runs every day 7 PM, Monday to Friday
 * Cron pattern: "0 19 * * 1-5"
 */
export function initializeDailyOhlcUpstoxJob(): void {
    // Run immediately when the application starts in development
    if (process.env.NODE_ENV === "development") {
        executeDailyOhlcUpstoxJob();
    }

    // Schedule to run every day 7 PM, Monday to Friday
    cron.schedule("0 19 * * 1-5", executeDailyOhlcUpstoxJob, {
        timezone: "Asia/Kolkata",
    });

    devLog("⏰ Daily OHLC Upstox Job scheduled to run every day 7 PM, Monday to Friday (IST)");
}
