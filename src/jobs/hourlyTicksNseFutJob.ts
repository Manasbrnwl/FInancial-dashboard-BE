import axios from "axios";
import { setAccessToken, getAccessToken } from "../config/store";
import cron from "node-cron";
import qs from "qs";
import { loadEnv } from "../config/env";
import { PrismaClient } from "@prisma/client";
import { sendEmailNotification } from "../utils/sendEmail";
import { rateLimiter } from "../utils/rateLimiter";

loadEnv();

const prisma = new PrismaClient();

// API endpoint for login
const LOGIN_API_URL =
  process.env.LOGIN_API_URL || "https://auth.truedata.in/token";

/**
 * Function to fetch access token from the login API
 */
async function fetchAccessToken(): Promise<boolean> {
  try {
    const credentials = {
      username: process.env.API_USERNAME || "FYERS2317",
      password: process.env.API_PASSWORD || "HO2LZYCf",
      grant_type: "password",
    };

    console.log("🔑 Fetching access token for hourly NSE Futures job...");

    const response = await axios.post(
      LOGIN_API_URL,
      qs.stringify(credentials),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = response.data.access_token;

    if (accessToken) {
      setAccessToken(accessToken);
      console.log("✅ Access token updated successfully for hourly job");
      return true;
    } else {
      console.error("❌ No access token received from API");
      return fetchAccessToken();
    }
  } catch (error: any) {
    console.error(
      "❌ Failed to fetch access token for hourly job:",
      error.message
    );
    return fetchAccessToken()
  }
}

/**
 * Function to get NSE Futures futures instruments with IDs from database
 */
async function getNseInstruments(): Promise<Map<string, number>> {
  try {
    console.log("🔍 Fetching NSE Futures instruments from database...");

    const instruments = await prisma.$queryRaw<Array<{
      instrumentid: number;
      instrument_type: string;
    }>>`
      SELECT DISTINCT li.id as instrumentId, fut.symbol as instrument_type
      FROM market_data.nse_futures fut
      INNER JOIN market_data.symbols_list li ON fut.symbol = li.symbol
      WHERE fut.expiry_date >= CURRENT_DATE
    `;

    console.log(`✅ Found ${instruments.length} NSE Futures futures instruments`);

    // Create a Map of instrument_type -> instrumentId
    const instrumentMap = new Map<string, number>();
    instruments.forEach((instrument) => {
      instrumentMap.set(instrument.instrument_type, instrument.instrumentid);
    });

    return instrumentMap;
  } catch (error: any) {
    console.error("❌ Failed to fetch NSE Futures instruments:", error.message);
    return new Map();
  }
}

/**
 * Function to transform API records to database format
 */
function transformRecordsToDbFormat(
  records: any[],
  instrumentId: number
): any[] {
  const now = new Date();
  return records.map((record) => ({
    instrumentId: instrumentId,
    ltp: record[1].toString(),
    volume: record[2].toString(),
    oi: record[3].toString(),
    bid: record[4].toString(),
    bidqty: record[5].toString(),
    ask: record[6].toString(),
    askqty: record[7].toString(),
    time: new Date(record[0]),
    updatedAt: now,
  }));
}

/**
 * Function to bulk insert ticks data into database
 */
async function bulkInsertTicksData(records: any[]): Promise<number> {
  try {
    const result = await prisma.ticksDataNSEFUT.createMany({
      data: records,
      skipDuplicates: true,
    });

    console.log(
      `✅ Successfully inserted ${result.count} records into ticksDataNSE`
    );
    return result.count;
  } catch (error: any) {
    console.error(`❌ Failed to bulk insert ticks data:`, error.message);
    return 0;
  }
}

/**
 * Function to fetch historical data for instruments
 */
async function fetchHistoricalData(instrumentsMap: Map<string, number>): Promise<{
  successfulInstrumentsCount: number;
  totalRecordsInserted: number;
}> {
  const accessToken = getAccessToken();

  if (!accessToken) {
    console.error("❌ No access token available for historical data fetch");
    return { successfulInstrumentsCount: 0, totalRecordsInserted: 0 };
  }

  const now = new Date();
  const today = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes() - 15,
    now.getSeconds()
  );

  // Format dates as YYMMDDTHH:MM:SS
  const date = `${today.getFullYear().toString().slice(-2)}${(
    today.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}${today
    .getDate()
    .toString()
    .padStart(2, "0")}`;
  // const fromDate = "251006T09:00:00";
  // const toDate = "251006T15:00:00";
  console.log(`📊 Fetching historical data for ${date}`);

  let successfulInstrumentsCount = 0;
  let totalRecordsInserted = 0;

  for (const [type, instrumentId] of instrumentsMap) {
    try {
      console.log(`🔄 Fetching data for instrument type: ${type}`);

      // Wait for rate limiter before making request
      await rateLimiter.waitForSlot();

      const stats = rateLimiter.getStats();
      console.log(
        `📊 Rate limit stats - Second: ${stats.perSecond}/5, Minute: ${stats.perMinute}/300, Hour: ${stats.perHour}/18000`
      );

      const response = await axios.get(
        `https://history.truedata.in/getticks?symbol=${type}&bidask=1&from=${date}T09:00:00&to=${date}T15:30:00&response=json`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        }
      );
      // Check if response status is success
      if (response.data && response.data.status === "Success") {
        successfulInstrumentsCount++;
        const recordsCount = response.data.Records
          ? response.data.Records.length
          : 0;
        console.log(
          `✅ Successfully fetched data for ${type} (Status: ${response.data.status})`
        );
        console.log(`📊 Data records: ${recordsCount}`);
        // Get instrument ID and insert data into database
        if (recordsCount > 0) {
          // Get only the last record from the response
          const lastRecord = [response.data.Records[response.data.Records.length - 1]];
          const transformedRecords = transformRecordsToDbFormat(
            lastRecord,
            instrumentId
          );
          const insertedCount = await bulkInsertTicksData(transformedRecords);
          totalRecordsInserted += insertedCount;
          console.log(
            `💾 Inserted ${insertedCount} records for ${type} (instrumentId: ${instrumentId})`
          );
        }
      } else {
        console.log(
          `⚠️ Data fetch for ${type} returned status: ${
            response.data?.status || "unknown"
          }`
        );
      }
    } catch (error: any) {
      console.error(`❌ Failed to fetch data for ${type}:`, error.message);
    }
  }

  console.log(
    `📈 Summary: ${successfulInstrumentsCount} out of ${instrumentsMap.size} instruments returned successful data`
  );
  console.log(`💾 Total records inserted: ${totalRecordsInserted}`);

  return { successfulInstrumentsCount, totalRecordsInserted };
}

/**
 * Function to send email notification for hourly job
 */
async function sendHourlyJobEmail(
  status: "started" | "completed" | "failed",
  details: {
    instrumentsCount?: number;
    successfulCount?: number;
    totalRecordsInserted?: number;
    errorMessage?: string;
  }
): Promise<void> {
  try {
    const date = new Date();
    const timeString = date.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: true,
    });

    let subject: string;
    let textContent: string;
    let htmlContent: string;

    switch (status) {
      case "started":
        subject = "📊 Hourly NSE Futures ticks Data Job Started";
        textContent = `Hourly NSE Futures ticks data job started at ${timeString}`;
        htmlContent = `
          <h2>📊 Hourly NSE Futures ticks Data Job Started</h2>
          <p><strong>Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> Job initialization successful</p>
          <p>Starting data fetch for NSE_FUT instruments...</p>
        `;
        break;

      case "completed":
        subject = "✅ Hourly NSE Futures ticks Data Job Completed Successfully";
        textContent = `Hourly NSE Futures ticks data job completed successfully at ${timeString}.
        Instruments processed: ${details.instrumentsCount || 0}
        Successful responses: ${details.successfulCount || 0}
        Total records inserted: ${details.totalRecordsInserted || 0}`;
        htmlContent = `
          <h2>✅ Hourly NSE Futures ticks Data Job Completed</h2>
          <p><strong>Completion Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ✅ Success</p>
          <hr>
          <h3>📈 Results Summary:</h3>
          <ul>
            <li><strong>Instruments Processed:</strong> ${
              details.instrumentsCount || 0
            }</li>
            <li><strong>Successful API Responses:</strong> ${
              details.successfulCount || 0
            }</li>
            <li><strong>Total Records Inserted:</strong> ${
              details.totalRecordsInserted || 0
            }</li>
          </ul>
          <p><em>Data successfully stored in ticksFODataNSE table.</em></p>
        `;
        break;

      case "failed":
        subject = "❌ Hourly NSE Futures ticks Data Job Failed";
        textContent = `Hourly NSE Futures ticks data job failed at ${timeString}. Error: ${details.errorMessage}`;
        htmlContent = `
          <h2>❌ Hourly NSE Futures ticks Data Job Failed</h2>
          <p><strong>Failure Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ❌ Failed</p>
          <hr>
          <h3>🚨 Error Details:</h3>
          <p><strong>Error Message:</strong> ${
            details.errorMessage || "Unknown error"
          }</p>
          <p><em>Please check the application logs for detailed information.</em></p>
        `;
        break;
    }

    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "mystmanas@gmail.com",
      subject,
      textContent,
      htmlContent
    );

    console.log(`📧 Email notification sent: ${status}`);
  } catch (error: any) {
    console.error(`❌ Failed to send email notification:`, error.message);
  }
}

/**
 * Main function to execute the hourly job
 */
async function executeHourlyJob(): Promise<void> {
  try {
    const date = new Date();
    console.log(`🕐 Starting hourly NSE Futures job at ${date.toISOString()}`);

    // Send start notification
    await sendHourlyJobEmail("started", {});

    // First login and get access token
    const loginSuccess = await fetchAccessToken();

    if (loginSuccess) {
      // Fetch NSE Futures instruments with their IDs
      const instrumentsMap = await getNseInstruments();

      // Fetch historical data for each instrument
      if (instrumentsMap.size > 0) {
        const result = await fetchHistoricalData(instrumentsMap);
        console.log(
          `🎯 Final Result: ${result.successfulInstrumentsCount} instruments returned successful responses with status="success"`
        );

        // Send completion notification
        await sendHourlyJobEmail("completed", {
          instrumentsCount: instrumentsMap.size,
          successfulCount: result.successfulInstrumentsCount,
          totalRecordsInserted: result.totalRecordsInserted,
        });
      } else {
        console.log(
          "⚠️ No instruments found, skipping historical data fetch"
        );

        // Send completion notification with zero results
        await sendHourlyJobEmail("completed", {
          instrumentsCount: 0,
          successfulCount: 0,
          totalRecordsInserted: 0,
        });
      }
    } else {
      console.error("❌ Skipping instrument query due to login failure");

      // Send failure notification
      await sendHourlyJobEmail("failed", {
        errorMessage: "Failed to fetch access token",
      });
    }

    console.log(
      `✅ Hourly NSE Futures job completed at ${new Date().toISOString()}`
    );
  } catch (error: any) {
    console.error("❌ Error in hourly NSE Futures job:", error.message);

    // Send failure notification
    await sendHourlyJobEmail("failed", {
      errorMessage: error.message,
    });
  }
}

/**
 * Initialize the hourly NSE Futures job
 * Runs every every 5 min from 9 AM to 6 PM, Monday to Friday
 * Cron pattern: "0 9-18 * * 1-5" (at minute 0 of every hour from 9 through 18 on Monday through Friday)
 */
export function initializeHourlyTicksNseFutJob(): void {
  // Run immediately when the application starts
  if(process.env.NODE_ENV === "development"){
    executeHourlyJob();
  }

  // Schedule to run every 5 min from 9 AM to 6 PM, Monday to Friday
  cron.schedule("*/5 9-15 * * 1-5", executeHourlyJob, {
    timezone: "Asia/Kolkata", // Indian timezone
  });

  console.log(
    "⏰ Hourly NSE Futures job scheduled to run every hour from 9 AM to 6 PM, Monday to Friday (IST)"
  );
}
