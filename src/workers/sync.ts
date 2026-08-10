import express from "express";
import dotenv from "dotenv";
import cron from "node-cron";
import { devLog, devError, prodError } from "../utils/errorLogger";
import { loadEnv } from "../config/env";
import { preloadInstrumentCache } from "../cache/instrumentCache";
import { initializeHourlyTicksNseOptJob } from "../jobs/hourlyTicksNseOptJob";
import { initializeHourlyTicksNseEqUpstoxJob } from "../jobs/hourlyTicksNseEqUpstoxJob";
import { initializeHourlyTicksNseFutUpstoxJob } from "../jobs/hourlyTicksNseFutUpstoxJob";
import { initializeDailyOhlcUpstoxJob } from "../jobs/dailyOhlcUpstoxJob";
import { initializeCoveredCallAlertJob } from "../jobs/coveredCallAlertJob";
import { initializeGapAverageLoader } from "../jobs/gapAverageLoader";
import { initializeGapHistoryCleanupJob } from "../jobs/gapHistoryCleanup";
import { initializeLoginReminderJob } from "../jobs/dailyLoginEmailJob";
import { syncHistoricalSymbols } from "../scripts/fetchHistoricalSymbols";
import { upstoxInstrumentService } from "../services/upstoxInstrumentService";
import { runFillBseEquity } from "../scripts/fillBseEquityFromBhavcopy";
import { withJobTracking } from "../utils/cronMonitor";

// Polyfill for BigInt JSON serialization
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const WEEKLY_SYMBOL_SYNC_CRON = "0 6 * * 2"; // Every Tuesday 6 AM IST
const WEEKLY_UPSTOX_TOKEN_REFRESH_CRON = "15 6 * * 2"; // Every Tuesday 6:15 AM IST, after the bhavcopy sync above
const DAILY_BSE_EQUITY_SYNC_CRON = "30 20 * * 1-5"; // Mon-Fri 8:30 PM IST, after BSE bhavcopy is typically published

async function syncNewSymbolsFromBhavcopy() {
  try {
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    const from = eightDaysAgo.toISOString().split("T")[0];
    const to = new Date().toISOString().split("T")[0];
    await syncHistoricalSymbols(from, to);
  } catch (error: any) {
    devError("Failed to sync instruments from Bhavcopy:", error.message);
    prodError("Failed to sync instruments from Bhavcopy");
  }
}

/**
 * Upstox recycles NSE_FO exchange tokens (symbols_list.upstox_id) across
 * expiries. Nothing else refreshes them, so they silently go stale and every
 * historical-candle/quote call for an affected contract starts failing with
 * "Invalid Instrument key". Re-matching against Upstox's current instrument
 * master by (instrument_id, symbol) keeps them current; safe to re-run any
 * time since it only refreshes rows, keyed off symbol, never off the token.
 */
async function refreshUpstoxTokens() {
  try {
    await upstoxInstrumentService.loadNseFutInstruments();
    await upstoxInstrumentService.loadNseOptInstruments();
  } catch (error: any) {
    devError("Failed to refresh Upstox instrument keys:", error.message);
    prodError("Failed to refresh Upstox instrument keys");
  }
}

/**
 * bse_equity was stuck at 2025-09-12 for ~11 months: the only code that ever
 * wrote to it (getBseEquityHistory, DhanHQ-based) was never wired to any
 * cron/script -- dead on arrival. DhanHQ also isn't a viable path right now
 * (no token configured, dhanTokenManager module referenced but doesn't
 * exist). BSE publishes the same UDiFF bhavcopy format NSE does, no auth
 * needed, so this fills from bhavcopy instead and resumes automatically from
 * MAX(bse_equity.date) + 1 day each run.
 */
async function syncBseEquityFromBhavcopy() {
  try {
    await runFillBseEquity();
  } catch (error: any) {
    devError("Failed to sync BSE equity from bhavcopy:", error.message);
    prodError("Failed to sync BSE equity from bhavcopy");
  }
}

/**
 * The sync-worker process — every cron job (tick ingestion, daily OHLC, covered
 * call alerts, gap baselines/cleanup, weekly instrument sync, login reminders).
 * Isolated from the API and realtime processes so a burst of Upstox Quote API
 * calls + DB writes every 5 minutes never competes with request handling or
 * live-tick fan-out on someone else's event loop.
 */
export function startSyncWorker(): void {
  dotenv.config();
  loadEnv();

  cron.schedule(
    WEEKLY_SYMBOL_SYNC_CRON,
    withJobTracking("weeklyBhavcopySymbolSync", WEEKLY_SYMBOL_SYNC_CRON, syncNewSymbolsFromBhavcopy),
    { timezone: "Asia/Kolkata" }
  );
  devLog("Weekly Bhavcopy Instrument Sync scheduled (Every Tuesday 6 AM IST)");

  cron.schedule(
    WEEKLY_UPSTOX_TOKEN_REFRESH_CRON,
    withJobTracking("weeklyUpstoxTokenRefresh", WEEKLY_UPSTOX_TOKEN_REFRESH_CRON, refreshUpstoxTokens),
    { timezone: "Asia/Kolkata" }
  );
  devLog("Weekly Upstox Token Refresh scheduled (Every Tuesday 6:15 AM IST)");

  cron.schedule(
    DAILY_BSE_EQUITY_SYNC_CRON,
    withJobTracking("dailyBseEquitySync", DAILY_BSE_EQUITY_SYNC_CRON, syncBseEquityFromBhavcopy),
    { timezone: "Asia/Kolkata" }
  );
  devLog("Daily BSE Equity Bhavcopy Sync scheduled (Mon-Fri 8:30 PM IST)");

  if (process.env.NODE_ENV === "development") {
    syncNewSymbolsFromBhavcopy();
  }

  // Preload instrument metadata cache for faster lookups (used by the jobs below)
  preloadInstrumentCache();

  initializeHourlyTicksNseOptJob();
  initializeHourlyTicksNseEqUpstoxJob();
  initializeHourlyTicksNseFutUpstoxJob();
  initializeDailyOhlcUpstoxJob();
  initializeCoveredCallAlertJob();
  initializeGapAverageLoader();
  initializeGapHistoryCleanupJob();
  initializeLoginReminderJob();

  // Minimal HTTP surface, just for container health checks — no business routes here.
  const app = express();
  const PORT = process.env.WORKER_HEALTH_PORT || 3002;
  app.get("/health", (_req, res) => {
    res.json({ success: true, message: "Sync worker is running", timestamp: new Date().toISOString() });
  });
  app.listen(PORT, () => {
    devLog(`Sync worker health endpoint on http://localhost:${PORT}`);
  });

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

if (require.main === module) {
  startSyncWorker();
}
