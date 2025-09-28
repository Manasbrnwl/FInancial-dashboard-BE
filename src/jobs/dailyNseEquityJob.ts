import axios from "axios";
import { setAccessToken, getAccessToken } from "../config/store";
import cron from "node-cron";
import qs from "qs";
import { loadEnv } from "../config/env";
import { PrismaClient } from "@prisma/client";

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

    console.log("🔑 Fetching access token for daily NSE Equity job...");

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
      console.log("✅ Access token updated successfully for daily job");
      return true;
    } else {
      console.error("❌ No access token received from API");
      return false;
    }
  } catch (error: any) {
    console.error(
      "❌ Failed to fetch access token for daily job:",
      error.message
    );
    return false;
  }
}

/**
 * Function to get NSE_EQT instrument types from database
 */
async function getNseEqtInstrumentTypes(): Promise<string[]> {
  try {
    console.log("🔍 Fetching NSE_EQT instrument types from database...");

    const nseEqtInstruments = await prisma.instrument_lists.findMany({
      where: {
        exchange: "NSE_EQ",
      },
      select: {
        instrument_type: true,
      },
    });

    console.log(
      `✅ Found ${nseEqtInstruments.length} NSE_EQT instrument types:`
    );

    const instrumentTypes: string[] = [];
    nseEqtInstruments.forEach((instrument, index) => {
      // console.log(`${index + 1}. ID: ${instrument.id}, Type: ${instrument.instrument_type}, Exchange: ${instrument.exchange}`);
      if (instrument.instrument_type) {
        instrumentTypes.push(instrument.instrument_type);
      }
    });

    return instrumentTypes;
  } catch (error: any) {
    console.error(
      "❌ Failed to fetch NSE_EQT instrument types:",
      error.message
    );
    return [];
  }
}

/**
 * Function to get instrument ID from database by instrument type
 */
async function getInstrumentId(instrumentType: string): Promise<number | null> {
  try {
    const instrument = await prisma.instrument_lists.findFirst({
      where: {
        exchange: "NSE_EQ",
        instrument_type: instrumentType,
      },
      select: {
        id: true,
      },
    });

    return instrument?.id || null;
  } catch (error: any) {
    console.error(
      `❌ Failed to get instrument ID for ${instrumentType}:`,
      error.message
    );
    return null;
  }
}

/**
 * Function to transform API records to database format
 */
function transformRecordsToDbFormat(
  records: any[],
  instrumentId: number
): any[] {
  return records.map((record) => ({
    instrumentId: instrumentId,
    open: record[1].toString(),
    high: record[2].toString(),
    low: record[3].toString(),
    close: record[4].toString(),
    volume: record[5].toString(),
    oi: record[6].toString(),
    time: new Date(record[0]),
  }));
}

/**
 * Function to bulk insert OHLC data into database
 */
async function bulkInsertOHLCData(records: any[]): Promise<number> {
  try {
    const result = await prisma.ohlcEQDataNSE.createMany({
      data: records,
      skipDuplicates: true,
    });

    console.log(
      `✅ Successfully inserted ${result.count} records into ohlcEQDataNSE`
    );
    return result.count;
  } catch (error: any) {
    console.error(`❌ Failed to bulk insert OHLC data:`, error.message);
    return 0;
  }
}

/**
 * Function to fetch historical data for instrument types
 */
async function fetchHistoricalData(instrumentTypes: string[]): Promise<number> {
  const accessToken = getAccessToken();

  if (!accessToken) {
    console.error("❌ No access token available for historical data fetch");
    return 0;
  }

  const now = new Date();
  const todayMorning = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    9,
    0,
    0
  );
  const todayEvening = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    16,
    0,
    0
  );

  // Format dates as YYMMDDTHH:MM:SS
  const fromDate = `${todayMorning.getFullYear().toString().slice(-2)}${(todayMorning.getMonth() + 1).toString().padStart(2, '0')}${todayMorning.getDate().toString().padStart(2, '0')}T${todayMorning.getHours().toString().padStart(2, '0')}:${todayMorning.getMinutes().toString().padStart(2, '0')}:${todayMorning.getSeconds().toString().padStart(2, '0')}`;
  const toDate = `${todayEvening.getFullYear().toString().slice(-2)}${(todayEvening.getMonth() + 1).toString().padStart(2, '0')}${todayEvening.getDate().toString().padStart(2, '0')}T${todayEvening.getHours().toString().padStart(2, '0')}:${todayEvening.getMinutes().toString().padStart(2, '0')}:${todayEvening.getSeconds().toString().padStart(2, '0')}`;
//   const fromDate = "250926T09:00:00";
//   const toDate = "250926T14:00:00";
  console.log(`📊 Fetching historical data from ${fromDate} to ${toDate}`);

  let successfulInstrumentsCount = 0;

  for (const type of instrumentTypes) {
    try {
      console.log(`🔄 Fetching data for instrument type: ${type}`);

      const response = await axios.get(
        `https://history.truedata.in/getbars?symbol=${type}&from=${fromDate}&to=${toDate}&response=json&interval=60min`,
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
          const instrumentId = await getInstrumentId(type);

          if (instrumentId) {
            const transformedRecords = transformRecordsToDbFormat(
              response.data.Records,
              instrumentId
            );
            const insertedCount = await bulkInsertOHLCData(transformedRecords);
            console.log(
              `💾 Inserted ${insertedCount} records for ${type} (instrumentId: ${instrumentId})`
            );
          } else {
            console.log(
              `⚠️ Could not find instrument ID for ${type}, skipping database insert`
            );
          }
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
    `📈 Summary: ${successfulInstrumentsCount} out of ${instrumentTypes.length} instruments returned successful data`
  );
  return successfulInstrumentsCount;
}

/**
 * Main function to execute the daily job
 */
async function executeDailyJob(): Promise<void> {
  try {
    const date = new Date();
    console.log(`🕐 Starting daily NSE Equity job at ${date.toISOString()}`);

    // First login and get access token
    const loginSuccess = await fetchAccessToken();

    if (loginSuccess) {
      // Then fetch NSE_EQT instrument types
      const instrumentTypes = await getNseEqtInstrumentTypes();

      // Fetch historical data for each instrument type
      if (instrumentTypes.length > 0) {
        const successfulCount = await fetchHistoricalData(instrumentTypes);
        console.log(
          `🎯 Final Result: ${successfulCount} instruments returned successful responses with status="success"`
        );
      } else {
        console.log(
          "⚠️ No instrument types found, skipping historical data fetch"
        );
      }
    } else {
      console.error("❌ Skipping instrument query due to login failure");
    }

    console.log(
      `✅ daily NSE equity job completed at ${new Date().toISOString()}`
    );
  } catch (error: any) {
    console.error("❌ Error in daily NSE Equity job:", error.message);
  }
}

/**
 * Initialize the daily NSE Equity job
 * Runs every day 7 PM, Monday to Friday
 * Cron pattern: "0 19 * * 1-5" (at minute 0 of every day at 18 on Monday through Friday)
 */
export function initializeDailyNseEquitysJob(): void {
  // Schedule to run every day 6 PM, Monday to Friday
  cron.schedule("0 19 * * 1-5", executeDailyJob, {
    timezone: "Asia/Kolkata", // Indian timezone
  });
  
  console.log(
    "⏰ daily NSE Equity job scheduled to run every day 7 PM, Monday to Friday (IST)"
  );
}
