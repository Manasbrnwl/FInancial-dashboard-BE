import axios from "axios";
import { setAccessToken } from "../config/store";
import cron from "node-cron";
import qs from "qs";
import { loadEnv } from "../config/env";
import { insertFutIntoDataBase } from "../nseFutures/insertFutIntoDataBase";
import { insertOptIntoDataBase } from "../nseOptions/insertOptIntoDataBase";
import { insertEqIntoDataBase } from "../nseEquity/insertEqtIntoDatabase";
import { sendEmailNotification } from "../utils/sendEmail";
import { getBseEquityHistory } from "../bseEquity/bseEquityHistory";
import { updateJobStatus, initializeJobStatus } from "../utils/cronMonitor";
loadEnv();

const CRON_EXPRESSION = "0 20 * * 1-5"; // 8 PM, Monday-Friday

// API endpoint for login
const LOGIN_API_URL =
  process.env.LOGIN_API_URL || "https://auth.truedata.in/token";

/**
 * Function to fetch access token from the login API
 */
async function fetchAccessToken(): Promise<void> {
  const startTime = Date.now();

  try {
    updateJobStatus('loginJob', 'running', CRON_EXPRESSION);

    // Replace with actual login credentials from environment variables
    const credentials = {
      username: process.env.API_USERNAME || "FYERS2317",
      password: process.env.API_PASSWORD || "HO2LZYCf",
      grant_type: "password",
    };

    // console.log('🔑 Fetching access token...');

    const response = await axios.post(
      LOGIN_API_URL,
      qs.stringify(credentials),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );
    // console.log('✅ Login response:', response.data);

    // Assuming the API returns the token in the response data
    const accessToken = response.data.access_token;
    const date = new Date();

    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "Finance Dashboard History Cron",
      `Cron jobs have been initialized and are scheduled as configured.`,
      `<h1>Finance Dashboard History</h1><p>Cron is initialized on <strong>${date}</strong></p><p>To upload all the data of NSE (EQ,F&O).</p>`
    );

    if (accessToken) {
      setAccessToken(accessToken);
      // getBseEquityHistory();
      insertFutIntoDataBase(date.toISOString().split("T")[0]);
      // insertFutIntoDataBase("2025-09-19");
      insertOptIntoDataBase(date.toISOString().split("T")[0]);
      // insertOptIntoDataBase("2025-09-30");
      insertEqIntoDataBase(date.toISOString().split("T")[0]);
      // insertEqIntoDataBase("2025-10-02");
      // console.log('✅ Access token updated successfully');

      const duration = Date.now() - startTime;
      updateJobStatus('loginJob', 'success', CRON_EXPRESSION, duration);
    } else {
      console.error("❌ No access token received from API");
      const duration = Date.now() - startTime;
      updateJobStatus('loginJob', 'failed', CRON_EXPRESSION, duration, 'No access token received from API');
      fetchAccessToken();
    }
  } catch (error: any) {
    console.error("❌ Failed to fetch access token:", error.message);
    const duration = Date.now() - startTime;
    updateJobStatus('loginJob', 'failed', CRON_EXPRESSION, duration, error.message);
    fetchAccessToken();
  }
}

/**
 * Initialize the daily NSE Equity job
 * Runs every day 8 PM, Monday to Friday
 * Cron pattern: "0 20 * * 1-5" (at minute 0 of every day at 20 on Monday through Friday)
 */
export function initializeLoginJob(): void {
  // Initialize job status in history
  initializeJobStatus('loginJob', CRON_EXPRESSION);

  // Run immediately when the application starts
  if(process.env.NODE_ENV === "development"){
    fetchAccessToken();
  }

  // Schedule to run every day at 8:00 PM
  cron.schedule(CRON_EXPRESSION, fetchAccessToken, {
    timezone: "Asia/Kolkata", // Indian timezone
  });

  console.log('⏰ Login job scheduled to run every day at 8:00 PM (Mon-Fri)');
}
