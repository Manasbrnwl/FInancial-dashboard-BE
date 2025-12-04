import cron from "node-cron";
import { getBseEquityHistory } from "../bseEquity/bseEquityHistory";
import { updateJobStatus, initializeJobStatus } from "../utils/cronMonitor";
import { isDhanTokenReady } from "./dhanTokenInitJob";

// Run daily at 10:00 PM, Monday-Friday (after NSE jobs complete)
const CRON_EXPRESSION = "0 22 * * 1-5";

/**
 * Execute BSE equity data fetch with status monitoring
 */
async function executeBseEquityJob(): Promise<void> {
  const startTime = Date.now();

  try {
    console.log("⏰ Starting BSE Equity job");

    // Check if Dhan token is initialized
    if (!isDhanTokenReady()) {
      console.error("❌ DhanHQ token manager not initialized. Skipping BSE Equity job.");
      updateJobStatus(
        "bseEquityJob",
        "failed",
        CRON_EXPRESSION,
        Date.now() - startTime,
        "DhanHQ token manager not initialized"
      );
      return;
    }

    updateJobStatus("bseEquityJob", "running", CRON_EXPRESSION);

    await getBseEquityHistory();

    const duration = Date.now() - startTime;
    updateJobStatus("bseEquityJob", "success", CRON_EXPRESSION, duration);
    console.log(`✅ BSE Equity job completed in ${Math.floor(duration / 60000)} minutes`);
  } catch (error: any) {
    const duration = Date.now() - startTime;
    console.error("❌ BSE Equity job failed:", error.message);
    updateJobStatus(
      "bseEquityJob",
      "failed",
      CRON_EXPRESSION,
      duration,
      error.message
    );
  }
}

/**
 * Initialize the daily BSE Equity job
 * Runs every day at 10:00 PM, Monday to Friday
 */
export function initializeBseEquityJob(): void {
  // Initialize job status in history
  initializeJobStatus("bseEquityJob", CRON_EXPRESSION);

  // Run immediately in development mode if needed
  // Uncomment the line below to run on startup in dev
  // if (process.env.NODE_ENV === "development") {
  //   executeBseEquityJob();
  // }

  // Schedule to run every day at 10:00 PM
  cron.schedule(CRON_EXPRESSION, executeBseEquityJob, {
    timezone: "Asia/Kolkata",
  });

  console.log("⏰ BSE Equity job scheduled to run daily at 10:00 PM (Mon-Fri)");
}
