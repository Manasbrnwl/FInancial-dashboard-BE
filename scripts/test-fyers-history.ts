/**
 * Fetches RELIANCE-EQ daily OHLCV candles for the last 10 trading days from FYERS API v3.
 *
 * Usage:
 *   1. Set FYERS_APP_ID and FYERS_ACCESS_TOKEN in your .env file.
 *   2. Run: ts-node scripts/test-fyers-history.ts
 *
 * How to get an access_token:
 *   - Log in at https://myapi.fyers.in/dashboard/
 *   - Create/select your app to get the App ID (client_id format: "APPID-100")
 *   - Complete the OAuth flow once to generate a session access_token.
 *   - The access_token is valid for one trading day (resets at midnight IST).
 */

import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// fyers-api-v3 ships as CJS with no official @types — use require.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fyersModel } = require("fyers-api-v3");

/** [timestamp, open, high, low, close, volume] */
type FyersCandle = [number, number, number, number, number, number];

interface FyersHistoryResponse {
  s: string; // "ok" | "error"
  candles?: FyersCandle[];
  message?: string;
  code?: number;
}

function formatDate(d: Date): string {
  return d.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

function epochToIST(epoch: number): string {
  return new Date(epoch * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
  });
}

async function main(): Promise<void> {
  const appId = process.env.FYERS_APP_ID;
  const accessToken = process.env.FYERS_ACCESS_TOKEN;

  if (!appId || !accessToken) {
    console.error(
      "❌  Missing credentials.\n" +
        "    Add FYERS_APP_ID and FYERS_ACCESS_TOKEN to your .env file.\n\n" +
        "    FYERS_APP_ID format  : <YOUR_APP_ID>-100\n" +
        "    FYERS_ACCESS_TOKEN   : token from OAuth session"
    );
    process.exit(1);
  }

  // ── Initialise SDK ──────────────────────────────────────────────────────────
  const fyers = new fyersModel({
    path: "./logs/fyers",
    enableLogging: false,
  });

  fyers.setAppId(appId);
  fyers.setAccessToken(accessToken);

  // ── Date range: today − 14 calendar days → today (covers ~10 trading days) ─
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - 14); // buffer for weekends/holidays

  const rangeFrom = formatDate(from);
  const rangeTo = formatDate(today);

  console.log(`\n📊 Fetching RELIANCE-EQ daily candles`);
  console.log(`   Range : ${rangeFrom}  →  ${rangeTo}`);
  console.log(`   App ID: ${appId}\n`);

  const params = {
    symbol: "NSE:RELIANCE-EQ",
    resolution: "D", // Daily candles
    date_format: "1", // Epoch timestamps
    range_from: rangeFrom,
    range_to: rangeTo,
    cont_flag: "1",
  };

  const response: FyersHistoryResponse = await fyers.getHistory(params);

  if (response.s !== "ok" || !response.candles) {
    console.error("❌  API error:", response.message ?? response);
    process.exit(1);
  }

  const candles = response.candles;

  // ── Print table ─────────────────────────────────────────────────────────────
  console.log(
    "Date (IST)                  │   Open   │   High   │    Low   │  Close   │    Volume"
  );
  console.log("─".repeat(90));

  for (const c of candles) {
    const [ts, open, high, low, close, volume] = c;
    const dateStr = epochToIST(ts).padEnd(27);
    console.log(
      `${dateStr}│ ${open.toFixed(2).padStart(8)} │ ${high.toFixed(2).padStart(8)} │ ${low.toFixed(2).padStart(8)} │ ${close.toFixed(2).padStart(8)} │ ${String(volume).padStart(12)}`
    );
  }

  console.log(`\n✅  ${candles.length} candle(s) returned.`);
}

main().catch((err: Error) => {
  console.error("❌  Unexpected error:", err.message);
  process.exit(1);
});
