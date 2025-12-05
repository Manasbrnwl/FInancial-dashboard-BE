import axios from "axios";
import { config } from "dotenv";
import { fetchInstruments } from "./instrumentsList";
import { insertBSEEqtIntoDataBase } from "./insertBSEEQIntoDatabase";
import { getDhanAccessToken } from "../config/store";
import prisma from "../config/prisma";
config();

interface instrumnets_list {
  SECURITY_ID: string;
  SYMBOL_NAME: string;
  INSTRUMENT_TYPE: string;
  EXCHANGE: string;
}

/**
 * Get yesterday's date in YYYY-MM-DD format
 */
function getYesterdayDate(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return yesterday.toISOString().split("T")[0];
}

/**
 * Convert timestamp to IST date
 */
function toISTDate(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Batch insert accumulated records
 */
async function batchInsertRecords(records: any[]): Promise<number> {
  if (records.length === 0) return 0;

  try {
    const result = await prisma.bse_equity.createMany({
      data: records,
      skipDuplicates: true,
    });
    return result.count;
  } catch (error: any) {
    console.error(`❌ Batch insert error:`, error.message);
    return 0;
  }
}

async function fetchHistorical(securityId: string) {
  try {
    // Use the dynamically managed Dhan access token from the token manager
    const clientToken = getDhanAccessToken();

    if (!clientToken) {
      throw new Error("DhanHQ access token not available. Ensure dhanTokenManager is initialized.");
    }

    const yesterdayDate = getYesterdayDate();

    const response = await axios.post(
      "https://api.dhan.co/v2/charts/historical",
      {
        securityId: String(securityId), // must be string
        exchangeSegment: "BSE_EQ",
        instrument: "EQUITY",
        expiryCode: 0,
        oi: false,
        fromDate: '2025-09-13', // YYYY-MM-DD
        toDate: yesterdayDate,
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
        status: null,
        error: err.message,
      };
    } else {
      return {
        success: false,
        status: null,
        error: err.message,
      };
    }
  }
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getBseEquityHistory() {
  const startTime = Date.now();
  const yesterdayDate = getYesterdayDate();

  console.log(`🚀 Starting BSE Equity data fetch for date: ${yesterdayDate}`);
  console.log(`⏱️ Using 2 second delay between requests`);
  console.log(`📦 Using batch inserts (50 instruments per batch)\n`);

  const instruments: instrumnets_list[] = await fetchInstruments();
  console.log(`📊 Found ${instruments.length} BSE instruments to process\n`);

  let successCount = 0;
  let errorCount = 0;
  let skippedCount = 0;
  let totalRecordsInserted = 0;

  // Batch configuration
  const BATCH_SIZE = 50;
  let recordsBatch: any[] = [];

  for (let i = 0; i < instruments.length; i++) {
    const instr = instruments[i];

    const data = await fetchHistorical(instr.SECURITY_ID);

    if (data.status === 400) {
      errorCount++;
      console.log(`❌ [${i + 1}/${instruments.length}] ${instr.SYMBOL_NAME} - API error 400`);
    } else if (!data.timestamp || data.timestamp.length === 0) {
      skippedCount++;
      console.log(`⚠️ [${i + 1}/${instruments.length}] ${instr.SYMBOL_NAME} - No data`);
    } else {
      // Accumulate records for batch insert
      for (let j = 0; j < data.timestamp.length; j++) {
        const ts = toISTDate(data.timestamp[j]);
        recordsBatch.push({
          symbol_id: instr.SECURITY_ID,
          symbol: instr.SYMBOL_NAME,
          date: new Date(ts),
          open: data.open[j],
          close: data.close[j],
          high: data.high[j],
          low: data.low[j],
          volume: data.volume[j].toString(),
          oi: "0",
          exchange: "BSE",
        });
      }

      successCount++;
      console.log(`✅ [${i + 1}/${instruments.length}] ${instr.SYMBOL_NAME} (${data.timestamp.length} records)`);
    }

    // Insert batch when we reach BATCH_SIZE instruments or at the end
    if ((i + 1) % BATCH_SIZE === 0 || i === instruments.length - 1) {
      if (recordsBatch.length > 0) {
        const inserted = await batchInsertRecords(recordsBatch);
        totalRecordsInserted += inserted;
        console.log(`\n💾 Batch insert completed: ${inserted} records inserted from ${recordsBatch.length} total\n`);
        recordsBatch = []; // Clear batch
      }

      // Progress update
      console.log(`📊 Progress: ${i + 1}/${instruments.length} (${Math.round((i + 1) / instruments.length * 100)}%)`);
      console.log(`✅ Success: ${successCount} | ⚠️ Skipped: ${skippedCount} | ❌ Errors: ${errorCount}`);
      console.log(`💾 Total records inserted: ${totalRecordsInserted}\n`);
    }

    await delay(1000);
  }

  const duration = Date.now() - startTime;
  const durationMinutes = Math.floor(duration / 60000);

  console.log("\n" + "=".repeat(50));
  console.log("✅ BSE Equity data fetch completed");
  console.log(`📊 Total instruments: ${instruments.length}`);
  console.log(`✅ Successfully processed: ${successCount}`);
  console.log(`⚠️ Skipped (no data): ${skippedCount}`);
  console.log(`❌ Errors: ${errorCount}`);
  console.log(`💾 Total records inserted: ${totalRecordsInserted}`);
  console.log(`⏱️ Duration: ${durationMinutes} minutes`);
  console.log("=".repeat(50));
}

export { getBseEquityHistory };
