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
      },
    });

    return symbols.map((s) => ({
      instrumentId: s.id,
      upstoxId: s.upstox_id!,
    }));
  } catch (error: any) {
    console.error("? Failed to fetch active options from DB:", error.message);
    return [];
  }
}

/**
 * Fetch Market Quotes from Upstox for a batch of keys.
 */
async function fetchQuotes(keys: string[], accessToken: string) {
  try {
    const url = `${UPSTOX_CONFIG.BASE_URL}/market/quote/quotes`;
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
      "? Failed to fetch quotes batch:",
      error.response?.data?.message || error.message
    );
    return null;
  }
}

/**
 * Main execution function for the 5-minute job.
 */
async function executeFiveMinuteJob() {
  const startTime = Date.now();
  console.log(`? Starting 5-minute NSE Options Job at ${new Date().toISOString()}`);

  try {
    // 1. Get Access Token (Must be valid)
    const token = upstoxAuthService.getAccessToken();
    if (!token) {
      console.error("? No Upstox Access Token available. Skipping job.");
      // Optional: Trigger re-login or alert
      return;
    }

    // 2. Get Active Instruments
    const instruments = await getActiveOptions();
    if (instruments.length === 0) {
      console.log("? No active options with Upstox IDs found.");
      return;
    }

    console.log(`? Found ${instruments.length} active options. Processing batches...`);

    // Create a lookup map for internal ID: upstoxId -> instrumentId
    const idMap = new Map<string, number>();
    instruments.forEach((i) => idMap.set(i.upstoxId, i.instrumentId));

    // 3. Batch Process
    let totalInserted = 0;
    const allKeys = instruments.map((i) => i.upstoxId);

    for (let i = 0; i < allKeys.length; i += BATCH_SIZE) {
      const batchKeys = allKeys.slice(i, i + BATCH_SIZE);
      const quotes = await fetchQuotes(batchKeys, token);

      if (quotes) {
        const dbRecords = [];
        const now = new Date(); // Use fetch time as timestamp

        for (const key of batchKeys) {
          const quote = quotes[key]; // Access by instrument_key
          if (!quote) continue;

          /* Upstox Quote Structure (Market Quote - Full):
             {
               last_price: 100.5,
               volume: 5000,
               oi: 100000,
               depth: { buy: [{quantity, price, orders}], sell: [...] },
               last_trade_time: "..."
             }
          */

          const instrumentId = idMap.get(key);
          if (!instrumentId) continue;

          // Extract best Bid/Ask
          const bestBid = quote.depth?.buy?.[0]?.price || 0;
          const bestBidQty = quote.depth?.buy?.[0]?.quantity || 0;
          const bestAsk = quote.depth?.sell?.[0]?.price || 0;
          const bestAskQty = quote.depth?.sell?.[0]?.quantity || 0;

          dbRecords.push({
            instrumentId: instrumentId,
            ltp: quote.last_price.toString(),
            volume: quote.volume.toString(),
            oi: quote.oi.toString(),
            bid: bestBid.toString(),
            bidqty: bestBidQty.toString(),
            ask: bestAsk.toString(),
            askqty: bestAskQty.toString(),
            time: now, // Storing snapshot time
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
    console.log(`? Job Completed. Inserted ${totalInserted} records in ${duration.toFixed(2)}s.`);

  } catch (error: any) {
    console.error("? Critical Error in 5-minute Options Job:", error.message);
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
  if (process.env.NODE_ENV === "production") {
    executeFiveMinuteJob();
  }
}
