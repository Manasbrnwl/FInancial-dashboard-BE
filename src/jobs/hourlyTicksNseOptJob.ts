import axios from "axios";
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { sendEmailNotification } from "../utils/sendEmail";
import { loadEnv } from "../config/env";

loadEnv();
const prisma = new PrismaClient();

// Batch size for Upstox Quote API (Upstox supports up to 500)
const BATCH_SIZE = 500;

interface InstrumentMap {
  upstoxId: string;
  instrumentId: number;
  upstoxName: string;
}

/**
 * Fetch active NSE Options with valid Upstox IDs from DB.
 */
async function getActiveOptions(): Promise<InstrumentMap[]> {
  try {
    const symbols = await prisma.symbols_list.findMany({
      where: {
        segment: "OPT",
        expiry_date: {
          gte: new Date(), // Active contracts only
        },
        upstox_id: {
          not: null, // Must have Upstox ID
        },
      },
      select: {
        id: true, // Internal instrumentId
        upstox_id: true,
        upstox_symbol: true,
      },
    });

    return symbols.map((s) => ({
      instrumentId: s.id,
      upstoxId: s.upstox_id!,
      upstoxName: s.upstox_symbol || "", // Handle null safety
    }));
  } catch (error: any) {
    console.error("❌ Failed to fetch active options from DB:", error.message);
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
      error.response?.data?.message || error.message
    );
    return null;
  }
}

/**
 * Main execution function for the 5-minute job.
 */
export async function executeFiveMinuteJob() {
  const startTime = Date.now();
  console.log(`⏰ Starting 5-minute NSE Options Job at ${new Date().toISOString()}`);

  try {
    // 1. Get Access Token (Must be valid)
    // const token = upstoxAuthService.getAccessToken();
    // if (!token) {
    //   console.error("? No Upstox Access Token available. Skipping job.");
    //   // Optional: Trigger re-login or alert
    //   return;
    // }
    const token = 'eyJ0eXAiOiJKV1QiLCJrZXlfaWQiOiJza192MS4wIiwiYWxnIjoiSFMyNTYifQ.eyJzdWIiOiI0U0NLOEsiLCJqdGkiOiI2OTNiYjc1YTcxNzY2OTNkNjFhNDJkMWIiLCJpc011bHRpQ2xpZW50IjpmYWxzZSwiaXNQbHVzUGxhbiI6dHJ1ZSwiaWF0IjoxNzY1NTIxMjQyLCJpc3MiOiJ1ZGFwaS1nYXRld2F5LXNlcnZpY2UiLCJleHAiOjE3NjU1NzY4MDB9.pS6kbheVK0AlKT41sw-pekjFTrVEsUFH0ZQx0JRM6eo';

    // 2. Get Active Instruments
    const instruments = await getActiveOptions();
    if (instruments.length === 0) {
      console.log("⚠️ No active options with Upstox IDs found.");
      return;
    }

    console.log(`✅ Found ${instruments.length} active options. Processing batches...`);

    // 3. Batch Process
    let totalInserted = 0;

    // We iterate through instruments in batches based on indices
    for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
      const batchInstruments = instruments.slice(i, i + BATCH_SIZE);
      const batchKeys = batchInstruments.map(inst => inst.upstoxId);

      const quotes = await fetchQuotes(batchKeys, token);

      if (quotes) {
        const dbRecords = [];
        const now = new Date(); // Use fetch time as timestamp

        for (const inst of batchInstruments) {
          // User request implies using upstox name for lookup.
          // Based on debug (Step 90), response keys use "NSE_FO:SYMBOL" format.
          const lookupKey = `NSE_FO:${inst.upstoxName}`;
          
          const quote = quotes[lookupKey];

          if (!quote) {
             continue;
          }

          // Extract best Bid/Ask
          const bestBid = quote.depth?.buy?.[0]?.price || 0;
          const bestBidQty = quote.depth?.buy?.[0]?.quantity || 0;
          const bestAsk = quote.depth?.sell?.[0]?.price || 0;
          const bestAskQty = quote.depth?.sell?.[0]?.quantity || 0;

          dbRecords.push({
            instrumentId: inst.instrumentId,
            ltp: quote.last_price.toString(),
            volume: quote.volume.toString(),
            oi: quote.oi.toString(),
            bid: bestBid.toString(),
            bidqty: bestBidQty.toString(),
            ask: bestAsk.toString(),
            askqty: bestAskQty.toString(),
            time: new Date(parseInt(quote.last_trade_time) + 19800000),
            updatedAt: now,
          });
        }

        if (dbRecords.length > 0) {
          const res = await prisma.ticksDataNSEOPT.createMany({
            data: dbRecords,
            skipDuplicates: true, // Avoid primary key collisions if any
          });
          totalInserted += res.count;
        }
      }

      // Basic rate limiting/politeness (Upstox is fast, but good practice)
      await new Promise(r => setTimeout(r, 200));
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ Job Completed. Inserted ${totalInserted} records in ${duration.toFixed(2)}s.`);

  } catch (error: any) {
    console.error("❌ Critical Error in 5-minute Options Job:", error.message);
    // await sendEmailNotification(...) // Optional failure alert
  }
}

/**
 * Initialize the cron job.
 */
export function initializeHourlyTicksNseOptJob(): void {
  // Run every 5 minutes from 9 AM to 3:30 PM (Mon-Fri)
  // Cron: */5 9-15 * * 1-5
  // Note: 15 refers to 3 PM hour. Need to handle 3:30 stop strictly if required, 
  // but running until 15:55 is usually fine for buffers.

  const schedule = "*/5 9-15 * * 1-5";

  cron.schedule(schedule, executeFiveMinuteJob, {
    timezone: "Asia/Kolkata",
  });

  console.log(`? 5-Minute Options Job Scheduled (${schedule})`);

  // Optional: Run once on start for DEV verification
  if (process.env.NODE_ENV === "development") {
    executeFiveMinuteJob();
  }
}
