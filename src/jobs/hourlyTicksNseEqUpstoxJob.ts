import axios from "axios";
import prisma from "../config/prisma";
import cron from "node-cron";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { sendEmailNotification } from "../utils/sendEmail";
import { loadEnv } from "../config/env";
import { devLog, devError, prodError } from "../utils/errorLogger";
import { upstoxQuoteService } from "../services/upstoxQuoteService";
import { withJobTracking } from "../utils/cronMonitor";

loadEnv();

// Batch size for Upstox Quote API
const BATCH_SIZE = 500;

interface InstrumentMap {
    upstoxId: string;
    instrumentId: number;
    upstoxName: string;
}

/**
 * Fetch active NSE Equity instruments from instrument_lists with valid Upstox Symbols.
 */
async function getActiveEquityInstruments(): Promise<InstrumentMap[]> {
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
                upstox_id: true,
                upstox_symbol: true,
                instrument_type: true
            },
        });

        return instruments.map((s) => ({
            instrumentId: s.id,
            upstoxId: s.upstox_id!,
            upstoxName: s.upstox_symbol || s.instrument_type,
        }));
    } catch (error: any) {
        devError("❌ Failed to fetch active equity instruments from DB:", error.message);
        prodError("Failed to fetch active equity instruments from DB");
        return [];
    }
}


/**
 * Function to send email notification for hourly job
 */
async function sendHourlyJobEmail(
    status: "started" | "completed" | "failed",
    details: {
        instrumentsCount?: number;
        successfulCount?: number;
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
                subject = "📊 5-Minute NSE Equity Snapshot Job Started";
                textContent = `NSE Equity snapshot job started at ${timeString}`;
                htmlContent = `
          <h2>📊 5-Minute NSE Equity Snapshot Job Started</h2>
          <p><strong>Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> Job initialization successful</p>
          <p>Starting data fetch for NSE Equity instruments via Upstox...</p>
        `;
                break;

            case "completed":
                subject = "✅ 5-Minute NSE Equity Snapshot Job Completed";
                textContent = `NSE Equity snapshot job completed successfully at ${timeString}.
        Instruments processed: ${details.instrumentsCount || 0}
        Total records inserted: ${details.totalRecordsInserted || 0}`;
                htmlContent = `
          <h2>✅ 5-Minute NSE Equity Snapshot Job Completed</h2>
          <p><strong>Completion Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ✅ Success</p>
          <hr>
          <h3>📈 Results Summary:</h3>
          <ul>
            <li><strong>Instruments Processed:</strong> ${details.instrumentsCount || 0}</li>
            <li><strong>Total Records Inserted:</strong> ${details.totalRecordsInserted || 0}</li>
          </ul>
          <p><em>Data successfully stored in ticksDataNSEEQ table.</em></p>
        `;
                break;

            case "failed":
                subject = "❌ 5-Minute NSE Equity Snapshot Job Failed";
                textContent = `NSE Equity snapshot job failed at ${timeString}. Error: ${details.errorMessage}`;
                htmlContent = `
          <h2>❌ 5-Minute NSE Equity Snapshot Job Failed</h2>
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
        prodError("Failed to send email notification");
    }
}

/**
 * Main execution function for the 5-minute job.
 */
export async function executeHourlyJob() {
    const startTime = Date.now();
    devLog(`⏰ Starting 5-minute NSE Equity Job at ${new Date().toISOString()}`);

    try {
        // Send start notification
        // await sendHourlyJobEmail("started", {});

        // 1. Get Access Token
        const token = await upstoxAuthService.getAccessToken();
        if (!token) {
            devError("? No Upstox Access Token available. Skipping job.");
            prodError("No Upstox Access Token for equity job");
            await sendHourlyJobEmail("failed", { errorMessage: "No Upstox Access Token available" });
            return;
        }

        // 2. Get Active Instruments
        const instruments = await getActiveEquityInstruments();
        if (instruments.length === 0) {
            devLog("⚠️ No active equity instruments with Upstox IDs found.");
            await sendHourlyJobEmail("completed", {
                instrumentsCount: 0,
                totalRecordsInserted: 0,
            });
            return;
        }

        devLog(`✅ Found ${instruments.length} active equity instruments. Processing batches...`);

        // 3. Batch Process
        let totalInserted = 0;

        for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
            const batchInstruments = instruments.slice(i, i + BATCH_SIZE);
            const batchKeys = batchInstruments.map(inst => `${inst.upstoxId}`);

            const quotes = await upstoxQuoteService.fetchQuotesResilient(batchKeys, token);

            if (quotes) {
                const dbRecords = [];
                const now = new Date();

                for (const inst of batchInstruments) {
                    // Use the instrument_key (upstoxId) directly as the lookup key
                    // The upstox_id field contains the correct format: NSE_EQ|INE848E01016
                    // This matches exactly what Upstox returns in the API response
                    const prefix = inst.upstoxId.split("|")[0];
                    const quote = quotes[`${prefix}:${inst.upstoxName}`];
                    if (!quote) {
                        continue;
                    }

                    // Extract best Bid/Ask
                    const bestBid = quote.depth?.buy?.[0]?.price || 0;
                    const bestBidQty = quote.depth?.buy?.[0]?.quantity || 0;
                    const bestAsk = quote.depth?.sell?.[0]?.price || 0;
                    const bestAskQty = quote.depth?.sell?.[0]?.quantity || 0;

                    if (bestBid === 0 && bestAsk === 0 && bestBidQty === 0 && bestAskQty === 0) {
                        continue;
                    }

                    // Time bucket calculation (nearest 5 min floor)
                    // Adjust timestamp (assuming +5.5h offset logic from other jobs is desired/correct)
                    const adjustedTime = new Date(parseInt(quote.last_trade_time) + 19800000);

                    const timeBucket = new Date(adjustedTime);
                    timeBucket.setSeconds(0, 0);
                    timeBucket.setMinutes(Math.floor(adjustedTime.getMinutes() / 5) * 5);

                    dbRecords.push({
                        instrumentId: inst.instrumentId,
                        ltp: quote.last_price.toString(),
                        volume: quote.volume.toString(),
                        oi: quote.oi.toString(),
                        bid: bestBid.toString(),
                        bidqty: bestBidQty.toString(),
                        ask: bestAsk.toString(),
                        askqty: bestAskQty.toString(),
                        time: adjustedTime,
                        time_bucket: timeBucket,
                        updatedAt: now,
                    });
                }

                if (dbRecords.length > 0) {
                    const res = await prisma.ticksDataNSEEQ.createMany({
                        data: dbRecords,
                        skipDuplicates: true,
                    });
                    totalInserted += res.count;
                }
            }

            await new Promise(r => setTimeout(r, 200));
        }

        const duration = (Date.now() - startTime) / 1000;
        devLog(`✅ Job Completed. Inserted ${totalInserted} records in ${duration.toFixed(2)}s.`);

        // Send completion notification
        await sendHourlyJobEmail("completed", {
            instrumentsCount: instruments.length,
            totalRecordsInserted: totalInserted,
        });

    } catch (error: any) {
        devError("❌ Critical Error in 5-minute Equity Job:", error.message);
        prodError("Critical error in 5-minute equity job");
        await sendHourlyJobEmail("failed", { errorMessage: error.message });
    }
}

/**
 * Initialize the cron job.
 */
export function initializeHourlyTicksNseEqUpstoxJob(): void {
    // Run every 5 minutes from 9 AM to 3:30 PM (Mon-Fri)
    // Cron: */5 9-15 * * 1-5
    const schedule = "*/5 9-15 * * 1-5";

    cron.schedule(schedule, withJobTracking("hourlyTicksNseEqUpstoxJob", schedule, executeHourlyJob), {
        timezone: "Asia/Kolkata",
    });

    devLog(`? 5-Minute NSE Equity Upstox Job Scheduled (${schedule})`);

    if (process.env.NODE_ENV === "development") {
        executeHourlyJob();
    }
}
