import cron from "node-cron";
import { loadGapBaselines } from "../cache/gapAverageCache";
import { loadEnv } from "../config/env";
import { devLog, devError, prodError } from "../utils/errorLogger";
import { withJobTracking } from "../utils/cronMonitor";

loadEnv();

const CRON_EXPRESSION = process.env.GAP_BASELINE_LOAD_CRON || "0 9 * * 1-5"; // 9:00 AM IST, Mon-Fri

export function initializeGapAverageLoader(): void {
  // Prime cache on startup
  loadGapBaselines().catch((error: any) => {
    devError("? Failed to load gap baselines on startup:", error?.message || error);
    prodError("Failed to load gap baselines on startup");
  });

  cron.schedule(
    CRON_EXPRESSION,
    withJobTracking("gapAverageLoader", CRON_EXPRESSION, async () => {
      try {
        await loadGapBaselines();
      } catch (error: any) {
        devError("? Failed to refresh gap baselines:", error?.message || error);
        prodError("Failed to refresh gap baselines");
      }
    }),
    { timezone: "Asia/Kolkata" }
  );

  devLog(
    `?? Gap baseline loader scheduled with cron "${CRON_EXPRESSION}" (IST timezone)`
  );
}
