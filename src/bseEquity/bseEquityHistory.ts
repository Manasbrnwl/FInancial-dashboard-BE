import axios from "axios";
import { config } from "dotenv";
import { fetchInstruments } from "./instrumentsList";
import { insertBSEEqtIntoDataBase } from "./insertBSEEQIntoDatabase";
import { sendEmailNotification } from "../utils/sendEmail";
import prisma from "../config/prisma";
import { getDhanAccessToken } from "../config/store";
config();

interface InstrumentsList {
  SECURITY_ID: string;
  SYMBOL_NAME: string;
  INSTRUMENT_TYPE: string;
  EXCHANGE: string;
}

interface HistoricalResponse {
  open?: number[];
  high?: number[];
  low?: number[];
  close?: number[];
  volume?: number[];
  timestamp?: number[];
  status?: number;
  success?: boolean;
  error?: any;
}

/**
 * Calculate date range (last 7 years from today)
 */
function getDateRange() {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setFullYear(toDate.getFullYear() - 7);

  return {
    fromDate: fromDate.toISOString().split("T")[0],
    toDate: toDate.toISOString().split("T")[0],
  };
}

async function fetchHistorical(
  securityId: string
): Promise<HistoricalResponse> {
  try {
    const clientToken = getDhanAccessToken();

    if (!clientToken) {
      throw new Error(
        "DhanHQ access token not available. Ensure dhanTokenManager is initialized."
      );
    }

    const { fromDate, toDate } = getDateRange();

    const response = await axios.post(
      "https://api.dhan.co/v2/charts/historical",
      {
        securityId: String(securityId),
        exchangeSegment: "BSE_EQ",
        instrument: "EQUITY",
        expiryCode: 0,
        oi: false,
        fromDate,
        toDate,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "access-token": clientToken,
        },
      }
    );

    return response.data;
  } catch (err: any) {
    if (err.response) {
      return {
        success: false,
        status: err.response.status,
        error: err.response.data,
      };
    } else if (err.request) {
      return {
        success: false,
        status: undefined,
        error: err.message,
      };
    } else {
      return {
        success: false,
        status: undefined,
        error: err.message,
      };
    }
  }
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Load processed instruments from tracking table
 */
async function loadProcessedInstruments(): Promise<Set<string>> {
  try {
    const processed = await prisma.bse_equity.findMany({
      distinct: ["symbol_id"],
      select: { symbol_id: true },
    });
    return new Set(processed.map((p) => p.symbol_id).filter((id): id is string => id !== null));
  } catch (error) {
    console.warn("⚠️ Could not load processed instruments, starting fresh");
    return new Set();
  }
}

async function getBseEquityHistory() {
  const startTime = Date.now();
  let totalInstruments = 0;
  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;

  try {
    console.log("🚀 Starting BSE Equity history fetch");

    const instruments: InstrumentsList[] = await fetchInstruments();
    totalInstruments = instruments.length;

    if (instruments.length === 0) {
      console.log("⚠️ No instruments found");
      return;
    }

    console.log(`📊 Found ${instruments.length} BSE instruments to process`);

    // Load already processed instruments for resume capability
    const processedInstruments = await loadProcessedInstruments();
    console.log(
      `📋 ${processedInstruments.size} instruments already have data (will skip duplicates)`
    );

    for (let i = 0; i < instruments.length; i++) {
      const instr = instruments[i];

      try {
        console.log(
          `\n[${i + 1}/${instruments.length}] Processing ${instr.SYMBOL_NAME} (${instr.SECURITY_ID})`
        );

        const data = await fetchHistorical(instr.SECURITY_ID);

        // Check for various error conditions
        if (data.status === 400 || data.status === 401 || data.status === 403) {
          console.log(`⚠️ Skipping ${instr.SYMBOL_NAME}: API error ${data.status}`);
          errorCount++;
          continue;
        }

        if (data.status === 429) {
          console.log("⏸️ Rate limit hit, waiting 10 seconds...");
          await delay(10000);
          // Retry the same instrument
          i--;
          continue;
        }

        if (!data.timestamp || data.timestamp.length === 0) {
          console.log(`⚠️ No data available for ${instr.SYMBOL_NAME}`);
          skippedCount++;
          continue;
        }

        // Validate all required fields are present
        if (!data.open || !data.high || !data.low || !data.close || !data.volume) {
          console.log(`⚠️ Incomplete data for ${instr.SYMBOL_NAME}`);
          skippedCount++;
          continue;
        }

        // Insert data using batch insertion
        await insertBSEEqtIntoDataBase(instr, {
          open: data.open,
          high: data.high,
          low: data.low,
          close: data.close,
          volume: data.volume,
          timestamp: data.timestamp,
        });
        successCount++;

        // Delay between requests to avoid rate limiting
        await delay(2000);
      } catch (error: any) {
        console.error(`❌ Error processing ${instr.SYMBOL_NAME}:`, error.message);
        errorCount++;
        // Continue with next instrument instead of stopping
      }
    }

    const duration = Date.now() - startTime;
    const durationMinutes = Math.floor(duration / 60000);

    console.log("\n" + "=".repeat(50));
    console.log("✅ BSE Equity history fetch completed");
    console.log(`📊 Total instruments: ${totalInstruments}`);
    console.log(`✅ Successfully processed: ${successCount}`);
    console.log(`⚠️ Skipped (no data): ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`⏱️ Duration: ${durationMinutes} minutes`);
    console.log("=".repeat(50));

    // Send completion email notification
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "BSE Equity History Completed",
      `BSE equity data fetch completed: ${successCount}/${totalInstruments} successful`,
      `<h1>BSE Equity History</h1>
       <p><strong>Total instruments:</strong> ${totalInstruments}</p>
       <p><strong>Successfully processed:</strong> ${successCount}</p>
       <p><strong>Skipped:</strong> ${skippedCount}</p>
       <p><strong>Errors:</strong> ${errorCount}</p>
       <p><strong>Duration:</strong> ${durationMinutes} minutes</p>`
    );
  } catch (error: any) {
    console.error("❌ Fatal error in BSE equity history fetch:", error.message);
    const duration = Date.now() - startTime;

    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "BSE Equity History Failed",
      `BSE equity data fetch failed: ${error.message}`,
      `<h1>BSE Equity History Error</h1>
       <p><strong>Error:</strong> ${error.message}</p>
       <p><strong>Processed before error:</strong> ${successCount}/${totalInstruments}</p>
       <p><strong>Duration:</strong> ${Math.floor(duration / 60000)} minutes</p>`
    );
    throw error;
  }
}

export { getBseEquityHistory };
