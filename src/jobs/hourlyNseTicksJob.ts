import axios from "axios";
import { setAccessToken, getAccessToken } from "../config/store";
import cron from "node-cron";
import qs from "qs";
import { loadEnv } from "../config/env";
import { PrismaClient } from "@prisma/client";
import { sendEmailNotification } from "../utils/sendEmail";

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

    console.log("🔑 Fetching access token for hourly NSE job...");

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
 * Function to get NSE_OPT instrument types from database
 */
async function getNseInstrumentTypes(): Promise<string[]> {
  try {
    console.log("🔍 Fetching NSE instrument types from database...");

    const nseInstruments = await prisma.instrument_lists.findMany({
      distinct: ["instrument_type"],
      select: {
        instrument_type: true,
      },
    });

    console.log(`✅ Found ${nseInstruments.length} NSE_OPT instrument types:`);

    const instrumentTypes: string[] = [];
    nseInstruments.forEach((instrument, index) => {
      // console.log(`${index + 1}. ID: ${instrument.id}, Type: ${instrument.instrument_type}, Exchange: ${instrument.exchange}`);
      if (instrument.instrument_type) {
        instrumentTypes.push(instrument.instrument_type);
      }
    });

    return instrumentTypes;
  } catch (error: any) {
    console.error("❌ Failed to fetch NSE instrument types:", error.message);
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
    ltp: record[1].toString(),
    volume: record[2].toString(),
    oi: record[3].toString(),
    bid: record[4].toString(),
    bidqty: record[5].toString(),
    ask: record[6].toString(),
    askqty: record[7].toString(),
    time: new Date(record[0]),
  }));
}

/**
 * Function to bulk insert ticks data into database
 */
async function bulkInsertTicksData(records: any[]): Promise<number> {
  try {
    const result = await prisma.ticksDataNSE.createMany({
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
 * Function to fetch historical data for instrument types
 */
async function fetchHistoricalData(instrumentTypes: string[]): Promise<{
  successfulInstrumentsCount: number;
  totalRecordsInserted: number;
}> {
  const accessToken = getAccessToken();

  if (!accessToken) {
    console.error("❌ No access token available for historical data fetch");
    return { successfulInstrumentsCount: 0, totalRecordsInserted: 0 };
  }

  const now = new Date();
  const todayMorning = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes() - 2,
    now.getSeconds()
  );
  const todayEvening = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    now.getHours(),
    now.getMinutes() + 2,
    now.getSeconds()
  );

  // Format dates as YYMMDDTHH:MM:SS
  const fromDate = `${todayMorning.getFullYear().toString().slice(-2)}${(
    todayMorning.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}${todayMorning
    .getDate()
    .toString()
    .padStart(2, "0")}T${todayMorning
    .getHours()
    .toString()
    .padStart(2, "0")}:${todayMorning
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${todayMorning
    .getSeconds()
    .toString()
    .padStart(2, "0")}`;
  const toDate = `${todayEvening.getFullYear().toString().slice(-2)}${(
    todayEvening.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}${todayEvening
    .getDate()
    .toString()
    .padStart(2, "0")}T${todayEvening
    .getHours()
    .toString()
    .padStart(2, "0")}:${todayEvening
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${todayEvening
    .getSeconds()
    .toString()
    .padStart(2, "0")}`;
  // const fromDate = "250926T09:00:00";
  // const toDate = "250926T14:00:00";
  console.log(`📊 Fetching historical data from ${fromDate} to ${toDate}`);

  let successfulInstrumentsCount = 0;
  let totalRecordsInserted = 0;

  for (const type of instrumentTypes) {
    try {
      console.log(`🔄 Fetching data for instrument type: ${type}`);

      const response = await axios.get(
        `https://history.truedata.in/getticks?symbol=${type}&bidask=1&from=${fromDate}&to=${toDate}&response=json`,
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
            const insertedCount = await bulkInsertTicksData(transformedRecords);
            totalRecordsInserted += insertedCount;
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
        subject = "📊 Hourly NSE ticks Data Job Started";
        textContent = `Hourly NSE ticks data job started at ${timeString}`;
        htmlContent = `
          <h2>📊 Hourly NSE ticks Data Job Started</h2>
          <p><strong>Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> Job initialization successful</p>
          <p>Starting data fetch for NSE_FUT instruments...</p>
        `;
        break;

      case "completed":
        subject = "✅ Hourly NSE ticks Data Job Completed Successfully";
        textContent = `Hourly NSE ticks data job completed successfully at ${timeString}.
        Instruments processed: ${details.instrumentsCount || 0}
        Successful responses: ${details.successfulCount || 0}
        Total records inserted: ${details.totalRecordsInserted || 0}`;
        htmlContent = `
          <h2>✅ Hourly NSE ticks Data Job Completed</h2>
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
        subject = "❌ Hourly NSE ticks Data Job Failed";
        textContent = `Hourly NSE ticks data job failed at ${timeString}. Error: ${details.errorMessage}`;
        htmlContent = `
          <h2>❌ Hourly NSE ticks Data Job Failed</h2>
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
    console.log(`🕐 Starting hourly NSE job at ${date.toISOString()}`);

    // Send start notification
    await sendHourlyJobEmail("started", {});

    // First login and get access token
    const loginSuccess = await fetchAccessToken();

    if (loginSuccess) {
      // Then fetch NSE instrument types
      const instrumentTypes = await getNseInstrumentTypes();

      // Fetch historical data for each instrument type
      if (instrumentTypes.length > 0) {
        const result = await fetchHistoricalData(instrumentTypes);
        console.log(
          `🎯 Final Result: ${result.successfulInstrumentsCount} instruments returned successful responses with status="success"`
        );

        // Send completion notification
        await sendHourlyJobEmail("completed", {
          instrumentsCount: instrumentTypes.length,
          successfulCount: result.successfulInstrumentsCount,
          totalRecordsInserted: result.totalRecordsInserted,
        });
      } else {
        console.log(
          "⚠️ No instrument types found, skipping historical data fetch"
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
      `✅ Hourly NSE job completed at ${new Date().toISOString()}`
    );
  } catch (error: any) {
    console.error("❌ Error in hourly NSE job:", error.message);

    // Send failure notification
    await sendHourlyJobEmail("failed", {
      errorMessage: error.message,
    });
  }
}

/**
 * Initialize the hourly NSE job
 * Runs every hour from 9 AM to 6 PM, Monday to Friday
 * Cron pattern: "0 9-18 * * 1-5" (at minute 0 of every hour from 9 through 18 on Monday through Friday)
 */
export function initializeHourlyNseJob(): void {
  // Run immediately when the application starts
  if(process.env.NODE_ENV === "development"){
    executeHourlyJob();
  }

  // Schedule to run every hour from 9 AM to 6 PM, Monday to Friday
  cron.schedule("0 9-18 * * 1-5", executeHourlyJob, {
    timezone: "Asia/Kolkata", // Indian timezone
  });

  console.log(
    "⏰ Hourly NSE job scheduled to run every hour from 9 AM to 6 PM, Monday to Friday (IST)"
  );
}
