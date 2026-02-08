import axios from "axios";
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { sendEmailNotification } from "../utils/sendEmail";
import { loadEnv } from "../config/env";
import { processGapData } from "../services/gapAlertService";

loadEnv();
const prisma = new PrismaClient();

// Batch size for Upstox Quote API
const BATCH_SIZE = 500;

// Gap calculation thresholds
const MIN_VOLUME_THRESHOLD = Number(process.env.MIN_VOLUME_THRESHOLD) || 10;
const MIN_TIME_DIFF = Number(process.env.MIN_TIME_DIFF) || 15 * 1000; // 15 seconds

type InstrumentLeg = {
    symbolId: number;        // instrument_id from symbols_list (FK to instrument_lists)
    instrumentId: number;    // id from symbols_list (for tick storage)
    instrumentType: string;  // symbol name (e.g., NIFTY25JANFUT)
    name: string;            // instrument_type from instrument_lists (e.g., NIFTY)
    expiry_date: Date;
    upstoxId: string;        // Upstox instrument key
    leg: "near" | "next" | "far";
};

type SymbolInstruments = {
    symbolId: number;        // instrument_id, used for gap grouping
    instruments: InstrumentLeg[];
};

type LegPriceData = {
    ltp: number;
    time: Date;
    volume: number;
};

/**
 * Fetch active NSE Futures instruments grouped by symbol with near/next/far legs.
 */
async function getActiveFuturesInstruments(): Promise<SymbolInstruments[]> {
    try {
        if (process.env.NODE_ENV === "development") {
            console.log("📊 Fetching NSE Futures instruments from database...");
        }

        const instruments = await prisma.$queryRaw<
            Array<{
                symbolid: number;
                name: string;
                instrumentid: number;
                instrument_type: string;
                expiry_date: Date;
                upstox_id: string;
            }>
        >`
            SELECT 
                sl.instrument_id as symbolId,
                il.instrument_type as name,
                sl.id as instrumentId,
                sl.symbol as instrument_type,
                sl.expiry_date,
                sl.upstox_id
            FROM market_data.symbols_list sl
            INNER JOIN market_data.instrument_lists il ON il.id = sl.instrument_id
            WHERE sl.expiry_date >= CURRENT_DATE 
                AND sl.segment = 'FUT'
                AND sl.upstox_id IS NOT NULL
                and sl.instrument_id = 9128
            ORDER BY symbolId ASC, expiry_date ASC
        `;

        // Group instruments by symbolId
        const grouped = new Map<number, InstrumentLeg[]>();
        instruments.forEach((instrument) => {
            const list = grouped.get(instrument.symbolid) || [];
            list.push({
                symbolId: instrument.symbolid,
                instrumentId: instrument.instrumentid,
                instrumentType: instrument.instrument_type,
                name: instrument.name,
                expiry_date: instrument.expiry_date,
                upstoxId: instrument.upstox_id,
                leg: "near", // Will be reassigned below
            });
            grouped.set(instrument.symbolid, list);
        });

        // Assign near/next/far legs
        const symbolInstruments: SymbolInstruments[] = [];
        const legOrder: InstrumentLeg["leg"][] = ["near", "next", "far"];

        grouped.forEach((list, symbolId) => {
            const sorted = list
                .sort((a, b) => a.expiry_date.getTime() - b.expiry_date.getTime())
                .slice(0, 3)
                .map((item, index) => ({
                    ...item,
                    leg: legOrder[index] ?? "far",
                }));

            // Need at least 2 legs for gap calculation
            if (sorted.length >= 2) {
                symbolInstruments.push({ symbolId, instruments: sorted });
            } else {
                if (process.env.NODE_ENV === "development") {
                    console.warn(
                        `⚠️ Skipping symbolId ${symbolId}: expected 2-3 futures (near/next/far), found ${sorted.length}`
                    );
                }
            }
        });

        if (process.env.NODE_ENV === "development") {
            console.log(
                `📈 Prepared ${symbolInstruments.length} symbols with near/next/far futures`
            );
        }

        return symbolInstruments;
    } catch (error: any) {
        console.error("❌ Failed to fetch active futures instruments from DB:", error.message);
        return [];
    }
}

/**
 * Fetch Market Quotes from Upstox for a batch of keys.
 */
async function fetchQuotes(keys: string[], accessToken: string) {
    try {
        const url = `${UPSTOX_CONFIG.BASE_URL}/market-quote/quotes`;
        const params = new URLSearchParams({
            instrument_key: keys.join(","),
        });

        const response = await axios.get(url, {
            params,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
            },
        });

        if (response.data.status === "success") {
            return response.data.data;
        }
        return null;
    } catch (error: any) {
        console.error(
            "❌ Failed to fetch quotes batch:",
            error.response?.data?.errors || error.message
        );
        return null;
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
        gapsEvaluated?: number;
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
                subject = "📊 5-Minute NSE Futures Snapshot Job Started (Upstox)";
                textContent = `NSE Futures snapshot job started at ${timeString}`;
                htmlContent = `
          <h2>📊 5-Minute NSE Futures Snapshot Job Started</h2>
          <p><strong>Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> Job initialization successful</p>
          <p>Starting data fetch for NSE Futures instruments via Upstox...</p>
        `;
                break;

            case "completed":
                subject = "✅ 5-Minute NSE Futures Snapshot Job Completed (Upstox)";
                textContent = `NSE Futures snapshot job completed successfully at ${timeString}.
        Instruments processed: ${details.instrumentsCount || 0}
        Total records inserted: ${details.totalRecordsInserted || 0}
        Gaps evaluated: ${details.gapsEvaluated || 0}`;
                htmlContent = `
          <h2>✅ 5-Minute NSE Futures Snapshot Job Completed</h2>
          <p><strong>Completion Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ✅ Success</p>
          <hr>
          <h3>📈 Results Summary:</h3>
          <ul>
            <li><strong>Instruments Processed:</strong> ${details.instrumentsCount || 0}</li>
            <li><strong>Total Records Inserted:</strong> ${details.totalRecordsInserted || 0}</li>
            <li><strong>Gaps Evaluated:</strong> ${details.gapsEvaluated || 0}</li>
          </ul>
          <p><em>Data successfully stored in ticksDataNSEFUT table.</em></p>
        `;
                break;

            case "failed":
                subject = "❌ 5-Minute NSE Futures Snapshot Job Failed (Upstox)";
                textContent = `NSE Futures snapshot job failed at ${timeString}. Error: ${details.errorMessage}`;
                htmlContent = `
          <h2>❌ 5-Minute NSE Futures Snapshot Job Failed</h2>
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
            console.log(`📧 Email notification sent: ${status}`);
        }
    } catch (error: any) {
        console.error(`❌ Failed to send email notification:`, error.message);
    }
}

/**
 * Main execution function for the 5-minute job.
 */
export async function executeHourlyFutJob() {
    const startTime = Date.now();
    console.log(`⏰ Starting 5-minute NSE Futures Job (Upstox) at ${new Date().toISOString()}`);

    try {
        // Send start notification
        await sendHourlyJobEmail("started", {});

        // 1. Get Access Token
        const token = await upstoxAuthService.getAccessToken();
        if (!token) {
            console.error("❓ No Upstox Access Token available. Skipping job.");
            await sendHourlyJobEmail("failed", { errorMessage: "No Upstox Access Token available" });
            return;
        }

        // 2. Get Active Instruments (grouped by symbol with near/next/far legs)
        const symbolGroups = await getActiveFuturesInstruments();
        console.log(`✅ Found ${symbolGroups.length} symbol`);
        if (symbolGroups.length === 0) {
            console.log("⚠️ No active futures instruments with Upstox IDs found.");
            await sendHourlyJobEmail("completed", {
                instrumentsCount: 0,
                totalRecordsInserted: 0,
                gapsEvaluated: 0,
            });
            return;
        }

        // Flatten all instruments for batch API calls
        const allInstruments = symbolGroups.flatMap(sg => sg.instruments);
        console.log(`✅ Found ${symbolGroups.length} symbol groups with ${allInstruments.length} total instruments. Processing batches...`);

        // 3. Batch Process - Fetch quotes and store data
        let totalInserted = 0;
        const legPrices: Record<number, Partial<Record<"near" | "next" | "far", LegPriceData>>> = {};

        for (let i = 0; i < allInstruments.length; i += BATCH_SIZE) {
            const batchInstruments = allInstruments.slice(i, i + BATCH_SIZE);
            const batchKeys = batchInstruments.map(inst => inst.upstoxId);

            const quotes = await fetchQuotes(batchKeys, token);

            if (quotes) {
                const dbRecords = [];
                const now = new Date();

                for (const inst of batchInstruments) {
                    // Response keys use "NSE_FO:SYMBOL" format for futures
                    const lookupKey = `NSE_FO:${inst.instrumentType}`;
                    const quote = quotes[lookupKey];
                    if (!quote) {
                        continue;
                    }

                    // Extract best Bid/Ask
                    const bestBid = quote.depth?.buy?.[0]?.price || 0;
                    const bestBidQty = quote.depth?.buy?.[0]?.quantity || 0;
                    const bestAsk = quote.depth?.sell?.[0]?.price || 0;
                    const bestAskQty = quote.depth?.sell?.[0]?.quantity || 0;

                    // Time adjustment (assuming +5.5h offset for IST)
                    const adjustedTime = new Date(parseInt(quote.last_trade_time) + 19800000);

                    // Time bucket calculation (nearest 5 min floor)
                    const timeBucket = new Date(adjustedTime);
                    timeBucket.setSeconds(0, 0);
                    timeBucket.setMinutes(Math.floor(adjustedTime.getMinutes() / 5) * 5);

                    // Track leg prices for gap calculation
                    if (!legPrices[inst.symbolId]) {
                        legPrices[inst.symbolId] = {};
                    }
                    legPrices[inst.symbolId][inst.leg] = {
                        ltp: quote.last_price,
                        time: adjustedTime,
                        volume: quote.volume || 0,
                    };

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
                        updatedAt: now,
                    });
                }
                
                if (dbRecords.length > 0) {
                    const res = await prisma.ticksDataNSEFUT.createMany({
                        data: dbRecords,
                        skipDuplicates: true,
                    });
                    totalInserted += res.count;
                }
            }

            await new Promise(r => setTimeout(r, 200));
        }

        // 4. Calculate Gaps
        const gapPayloads: Parameters<typeof processGapData>[0] = [];

        for (const symbol of symbolGroups) {
            const prices = legPrices[symbol.symbolId];
            if (!prices) continue;

            let gap_1: number | undefined;
            let gap_2: number | undefined;
            let timestamp: Date | undefined;

            // Calculate Gap 1 (Next - Near)
            if (prices.near && prices.next) {
                const timeDiff = Math.abs(
                    prices.near.time.getTime() - prices.next.time.getTime()
                );

                // Liquidity Check
                const isLiquid =
                    prices.near.volume >= MIN_VOLUME_THRESHOLD &&
                    prices.next.volume >= MIN_VOLUME_THRESHOLD;

                if (timeDiff <= MIN_TIME_DIFF && isLiquid) {
                    gap_1 = prices.next.ltp - prices.near.ltp;
                    timestamp = new Date(
                        Math.max(prices.near.time.getTime(), prices.next.time.getTime())
                    );
                } else {
                    if (process.env.NODE_ENV === "development") {
                        if (!isLiquid) {
                            console.warn(
                                `⚠️ Skipping Gap 1 for ${symbol.symbolId}: Low Liquidity (Near: ${prices.near.volume}, Next: ${prices.next.volume})`
                            );
                        } else {
                            console.warn(
                                `⚠️ Skipping Gap 1 for ${symbol.symbolId}: Time diff ${timeDiff / 1000}s > ${MIN_TIME_DIFF / 1000}s`
                            );
                        }
                    }
                }
            }

            // Calculate Gap 2 (Far - Next)
            if (prices.next && prices.far) {
                const timeDiff = Math.abs(
                    prices.next.time.getTime() - prices.far.time.getTime()
                );

                // Liquidity Check
                const isLiquid =
                    prices.next.volume >= MIN_VOLUME_THRESHOLD &&
                    prices.far.volume >= MIN_VOLUME_THRESHOLD;

                if (timeDiff <= MIN_TIME_DIFF && isLiquid) {
                    gap_2 = prices.far.ltp - prices.next.ltp;
                    const currentMax = timestamp?.getTime() || 0;
                    timestamp = new Date(
                        Math.max(
                            currentMax,
                            prices.next.time.getTime(),
                            prices.far.time.getTime()
                        )
                    );
                } else {
                    if (process.env.NODE_ENV === "development") {
                        if (!isLiquid) {
                            console.warn(
                                `⚠️ Skipping Gap 2 for ${symbol.symbolId}: Low Liquidity (Next: ${prices.next.volume}, Far: ${prices.far.volume})`
                            );
                        } else {
                            console.warn(
                                `⚠️ Skipping Gap 2 for ${symbol.symbolId}: Time diff ${timeDiff / 1000}s > ${MIN_TIME_DIFF / 1000}s`
                            );
                        }
                    }
                }
            }

            if ((gap_1 !== undefined || gap_2 !== undefined) && timestamp) {
                gapPayloads.push({
                    instrumentId: symbol.symbolId,
                    instrumentName: symbol.instruments[0].name,
                    gap_1: gap_1 ?? null,
                    gap_2: gap_2 ?? null,
                    price_1: prices.near?.ltp,
                    price_2: prices.next?.ltp,
                    price_3: prices.far?.ltp,
                    timestamp,
                });
            } else {
                if (process.env.NODE_ENV === "development") {
                    console.warn(
                        `⚠️ No valid gaps calculated for symbolId ${symbol.symbolId} (insufficient legs or time sync issues)`
                    );
                }
            }
        }

        // 5. Process Gaps
        if (gapPayloads.length > 0) {
            try {
                await processGapData(gapPayloads);
                if (process.env.NODE_ENV === "development") {
                    console.log(`📈 Processed ${gapPayloads.length} gap calculations`);
                }
            } catch (error: any) {
                console.error("❌ Failed to process gap data:", error.message);
            }
        }

        const duration = (Date.now() - startTime) / 1000;
        console.log(`✅ Job Completed. Inserted ${totalInserted} records, evaluated ${gapPayloads.length} gaps in ${duration.toFixed(2)}s.`);

        // Send completion notification
        await sendHourlyJobEmail("completed", {
            instrumentsCount: allInstruments.length,
            totalRecordsInserted: totalInserted,
            gapsEvaluated: gapPayloads.length,
        });

    } catch (error: any) {
        console.error("❌ Critical Error in 5-minute Futures Job:", error.message);
        await sendHourlyJobEmail("failed", { errorMessage: error.message });
    }
}

/**
 * Initialize the cron job.
 */
export function initializeHourlyTicksNseFutUpstoxJob(): void {
    // Run every 5 minutes from 9 AM to 3:30 PM (Mon-Fri)
    // Cron: */5 9-15 * * 1-5
    const schedule = "*/5 9-15 * * 1-5";

    cron.schedule(schedule, executeHourlyFutJob, {
        timezone: "Asia/Kolkata",
    });

    console.log(`📈 5-Minute NSE Futures Upstox Job Scheduled (${schedule})`);

    // Run immediately in development mode
    if (process.env.NODE_ENV === "development") {
        executeHourlyFutJob();
    }
}
