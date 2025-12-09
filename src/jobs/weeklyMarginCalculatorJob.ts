import cron from "node-cron";
import {
  marginCalculatorService,
  ExchangeSegment,
  TransactionType,
  ProductType,
  MarginCalculatorRequest,
} from "../services/marginCalculatorService";
import { updateJobStatus, initializeJobStatus } from "../utils/cronMonitor";
import { isDhanTokenReady } from "./dhanTokenInitJob";
import { sendEmailNotification } from "../utils/sendEmail";
import prisma from "../config/prisma";

// Run every Sunday at 2:00 AM
const CRON_EXPRESSION = "0 2 * * 0";

/**
 * Fetch NSE Equity instruments with latest prices
 */
async function fetchNseEquityInstruments(): Promise<MarginCalculatorRequest[]> {
  try {
    console.log("📊 Fetching NSE Equity instruments...");

    // Get distinct symbols with their latest data
    const instruments = await prisma.$queryRaw<
      Array<{
        symbol_id: string;
        symbol: string;
        close: number;
      }>
    >`
      SELECT DISTINCT ON (symbol_id)
        symbol_id,
        symbol,
        close
      FROM market_data.nse_equity
      WHERE close IS NOT NULL
      ORDER BY symbol_id, date DESC
      LIMIT 500
    `;

    console.log(`   ✅ Found ${instruments.length} NSE EQ instruments`);

    return instruments.map((inst) => ({
      securityId: inst.symbol_id,
      symbol: inst.symbol,
      exchangeSegment: ExchangeSegment.NSE_EQ,
      transactionType: TransactionType.BUY,
      quantity: 1,
      productType: ProductType.INTRADAY,
      price: inst.close || 100, // Use latest close price or default
    }));
  } catch (error: any) {
    console.error("❌ Error fetching NSE EQ instruments:", error.message);
    return [];
  }
}

/**
 * Fetch NSE F&O instruments with latest prices
 */
async function fetchNseFnoInstruments(): Promise<MarginCalculatorRequest[]> {
  try {
    console.log("📊 Fetching NSE F&O instruments...");

    // Get active futures with latest data
    const futures = await prisma.$queryRaw<
      Array<{
        symbol_id: string;
        symbol: number;
        close: number;
        expiry_date: Date;
      }>
    >`
      SELECT DISTINCT ON (symbol_id, expiry_date)
        symbol_id,
        symbol,
        close,
        expiry_date
      FROM market_data.nse_futures
      WHERE close IS NOT NULL
        AND expiry_date >= CURRENT_DATE
      ORDER BY symbol_id, expiry_date, date DESC
      LIMIT 200
    `;

    console.log(`   ✅ Found ${futures.length} NSE F&O instruments`);

    return futures.map((inst) => ({
      securityId: inst.symbol_id || inst.symbol.toString(),
      symbol: `FUT_${inst.symbol}`,
      exchangeSegment: ExchangeSegment.NSE_FNO,
      transactionType: TransactionType.BUY,
      quantity: 1,
      productType: ProductType.INTRADAY,
      price: inst.close || 100,
    }));
  } catch (error: any) {
    console.error("❌ Error fetching NSE F&O instruments:", error.message);
    return [];
  }
}

/**
 * Fetch BSE Equity instruments with latest prices
 */
async function fetchBseEquityInstruments(): Promise<MarginCalculatorRequest[]> {
  try {
    console.log("📊 Fetching BSE Equity instruments...");

    // Get distinct symbols with their latest data
    const instruments = await prisma.$queryRaw<
      Array<{
        symbol_id: string;
        symbol: string;
        close: number;
      }>
    >`
      SELECT DISTINCT ON (symbol_id)
        symbol_id,
        symbol,
        close
      FROM market_data.bse_equity
      WHERE close IS NOT NULL
        AND symbol_id IS NOT NULL
      ORDER BY symbol_id, date DESC
      LIMIT 200
    `;

    console.log(`   ✅ Found ${instruments.length} BSE EQ instruments`);

    return instruments.map((inst) => ({
      securityId: inst.symbol_id,
      symbol: inst.symbol,
      exchangeSegment: ExchangeSegment.BSE_EQ,
      transactionType: TransactionType.BUY,
      quantity: 1,
      productType: ProductType.INTRADAY,
      price: inst.close || 100,
    }));
  } catch (error: any) {
    console.error("❌ Error fetching BSE EQ instruments:", error.message);
    return [];
  }
}

/**
 * Calculate margins for all instruments
 */
async function calculateAllMargins() {
  const startTime = Date.now();
  let totalProcessed = 0;
  let totalSuccessful = 0;
  let totalFailed = 0;

  try {
    console.log("\n🚀 Starting weekly margin calculation job...");
    updateJobStatus("weeklyMarginCalculatorJob", "running", CRON_EXPRESSION);

    // Check if Dhan token is ready
    if (!isDhanTokenReady()) {
      console.error("❌ DhanHQ token manager not initialized");
      throw new Error("DhanHQ token manager not initialized");
    }

    // Step 1: Fetch all instruments
    console.log("\n📋 Step 1: Fetching instruments from database...");
    const [nseEqInstruments, nseFnoInstruments, bseEqInstruments] =
      await Promise.all([
        fetchNseEquityInstruments(),
        fetchNseFnoInstruments(),
        fetchBseEquityInstruments(),
      ]);

    const allInstruments = [
      ...nseEqInstruments,
      ...nseFnoInstruments,
      ...bseEqInstruments,
    ];

    totalProcessed = allInstruments.length;
    console.log(`\n📊 Total instruments to process: ${totalProcessed}`);
    console.log(`   - NSE Equity: ${nseEqInstruments.length}`);
    console.log(`   - NSE F&O: ${nseFnoInstruments.length}`);
    console.log(`   - BSE Equity: ${bseEqInstruments.length}`);

    if (allInstruments.length === 0) {
      console.log("⚠️ No instruments found to process");
      const duration = Date.now() - startTime;
      updateJobStatus(
        "weeklyMarginCalculatorJob",
        "success",
        CRON_EXPRESSION,
        duration
      );
      return;
    }

    // Step 2: Calculate margins in batches
    console.log("\n💰 Step 2: Calculating margins...");
    const BATCH_SIZE = 50;
    const batches = [];

    for (let i = 0; i < allInstruments.length; i += BATCH_SIZE) {
      batches.push(allInstruments.slice(i, i + BATCH_SIZE));
    }

    console.log(`   Processing ${batches.length} batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(
        `\n   [Batch ${i + 1}/${batches.length}] Processing ${batch.length} instruments...`
      );

      const result = await marginCalculatorService.calculateBulkMargins(batch);

      totalSuccessful += result.successful;
      totalFailed += result.failed;

      console.log(
        `   ✅ Batch ${i + 1} complete: ${result.successful} successful, ${result.failed} failed`
      );

      // Small delay between batches
      if (i < batches.length - 1) {
        await delay(2000);
      }
    }

    const duration = Date.now() - startTime;
    const durationMinutes = Math.floor(duration / 60000);

    // Success summary
    console.log("\n" + "=".repeat(60));
    console.log("✅ Weekly margin calculation completed");
    console.log(`📊 Total processed: ${totalProcessed}`);
    console.log(`✅ Successful: ${totalSuccessful}`);
    console.log(`❌ Failed: ${totalFailed}`);
    console.log(`⏱️ Duration: ${durationMinutes} minutes`);
    console.log("=".repeat(60));

    updateJobStatus(
      "weeklyMarginCalculatorJob",
      "success",
      CRON_EXPRESSION,
      duration
    );

    // Send email notification
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "Weekly Margin Calculation Completed",
      `Weekly margin calculation completed: ${totalSuccessful}/${totalProcessed} successful`,
      `<h1>Weekly Margin Calculator</h1>
       <p><strong>Total instruments:</strong> ${totalProcessed}</p>
       <ul>
         <li>NSE Equity: ${nseEqInstruments.length}</li>
         <li>NSE F&O: ${nseFnoInstruments.length}</li>
         <li>BSE Equity: ${bseEqInstruments.length}</li>
       </ul>
       <p><strong>Successfully calculated:</strong> ${totalSuccessful}</p>
       <p><strong>Failed:</strong> ${totalFailed}</p>
       <p><strong>Duration:</strong> ${durationMinutes} minutes</p>
       <p><strong>Next run:</strong> Next Sunday at 2:00 AM</p>`
    );
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error("\n❌ Weekly margin calculation failed:", error.message);

    updateJobStatus(
      "weeklyMarginCalculatorJob",
      "failed",
      CRON_EXPRESSION,
      duration,
      error.message
    );

    // Send failure notification
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "Weekly Margin Calculation Failed",
      `Weekly margin calculation failed: ${error.message}`,
      `<h1>Weekly Margin Calculator Error</h1>
       <p><strong>Error:</strong> ${error.message}</p>
       <p><strong>Processed:</strong> ${totalSuccessful}/${totalProcessed}</p>
       <p><strong>Duration:</strong> ${Math.floor(duration / 60000)} minutes</p>
       <p>Please check the application logs for more details.</p>`
    );
  }
}

/**
 * Utility delay function
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Initialize the weekly margin calculator job
 * Runs every Sunday at 2:00 AM
 */
export function initializeWeeklyMarginCalculatorJob(): void {
  // Initialize job status in history
  initializeJobStatus("weeklyMarginCalculatorJob", CRON_EXPRESSION);

  // Uncomment to run immediately in development
  if (process.env.NODE_ENV === "development") {
    calculateAllMargins();
  }

  // Schedule to run every Sunday at 2:00 AM
  cron.schedule(CRON_EXPRESSION, calculateAllMargins, {
    timezone: "Asia/Kolkata",
  });

  console.log(
    "⏰ Weekly margin calculator job scheduled to run every Sunday at 2:00 AM"
  );
}
