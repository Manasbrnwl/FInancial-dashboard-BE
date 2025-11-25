import axios from "axios";
import { setAccessToken, getAccessToken } from "../config/store";
import cron from "node-cron";
import qs from "qs";
import { loadEnv } from "../config/env";
import { PrismaClient } from "@prisma/client";
import { sendEmailNotification } from "../utils/sendEmail";
import { rateLimiter } from "../utils/rateLimiter";
import { updateJobStatus, initializeJobStatus } from "../utils/cronMonitor";
import { processGapData } from "../services/gapAlertService";

loadEnv();

const prisma = new PrismaClient();
const CRON_EXPRESSION = "*/5 9-15 * * 1-5"; // Every 5 min, 9 AM to 3 PM, Mon-Fri

type InstrumentLeg = {
  symbolId: number;
  instrumentId: number;
  instrumentType: string;
  expiry_date: Date;
  leg: "near" | "next" | "far";
};

type SymbolInstruments = {
  symbolId: number;
  instruments: InstrumentLeg[];
};

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

    console.log("?? Fetching access token for hourly NSE Futures job...");

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
      console.log("? Access token updated successfully for hourly job");
      return true;
    } else {
      console.error("? No access token received from API");
      return fetchAccessToken();
    }
  } catch (error: any) {
    console.error(
      "? Failed to fetch access token for hourly job:",
      error.message
    );
    return fetchAccessToken();
  }
}

/**
 * Fetch NSE FUT instruments grouped as near/next/far legs per symbol
 */
async function getNseInstruments(): Promise<SymbolInstruments[]> {
  try {
    console.log("?? Fetching NSE Futures instruments from database...");

    const instruments = await prisma.$queryRaw<
      Array<{
        symbolid: number;
        instrumentid: number;
        instrument_type: string;
        expiry_date: Date;
      }>
    >`
      select instrument_id as symbolId,
             id as instrumentId,
             symbol as instrument_type,
             expiry_date
      from market_data.symbols_list
      where expiry_date >= CURRENT_DATE and segment = 'FUT'
      order by symbolId asc, expiry_date asc
    `;

    const grouped = new Map<number, InstrumentLeg[]>();
    instruments.forEach(
      (instrument: {
        symbolid: number;
        instrumentid: number;
        instrument_type: string;
        expiry_date: Date;
      }) => {
        const list = grouped.get(instrument.symbolid) || [];
        list.push({
          symbolId: instrument.symbolid,
          instrumentId: instrument.instrumentid,
          instrumentType: instrument.instrument_type,
          expiry_date: instrument.expiry_date,
          leg: "near",
        });
        grouped.set(instrument.symbolid, list);
      }
    );

    const symbolInstruments: SymbolInstruments[] = [];
    const legOrder: InstrumentLeg["leg"][] = ["near", "next", "far"];
    grouped.forEach((list, symbolId) => {
      const sorted = list
        .sort((a, b) => a.expiry_date.getTime() - b.expiry_date.getTime())
        .slice(0, 3)
        .map((item, index) => ({
          ...item,
          leg: legOrder[index] ?? "far",
        }));

      if (sorted.length >= 1 ) {
        symbolInstruments.push({ symbolId, instruments: sorted });
      } else {
        console.warn(
          `? Skipping symbolId ${symbolId}: expected 3 futures (near/next/far), found ${sorted.length}`
        );
      }
    });

    console.log(
      `?? Prepared ${symbolInstruments.length} symbols with near/next/far futures`
    );

    return symbolInstruments;
  } catch (error: any) {
    console.error("? Failed to fetch NSE Futures instruments:", error.message);
    return [];
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
      `? Successfully inserted ${result.count} records into ticksDataNSE`
    );
    return result.count;
  } catch (error: any) {
    console.error(`? Failed to bulk insert ticks data:`, error.message);
    return 0;
  }
}

/**
 * Function to fetch historical data for instruments and compute gaps
 */
async function fetchHistoricalData(symbols: SymbolInstruments[]): Promise<{
  processedSymbols: number;
  successfulLegRequests: number;
  totalRecordsInserted: number;
  gapsEvaluated: number;
}> {
  const accessToken = getAccessToken();

  if (!accessToken) {
    console.error("? No access token available for historical data fetch");
    return {
      processedSymbols: 0,
      successfulLegRequests: 0,
      totalRecordsInserted: 0,
      gapsEvaluated: 0,
    };
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

  const date = `${today.getFullYear().toString().slice(-2)}${(
    today.getMonth() + 1
  )
    .toString()
    .padStart(2, "0")}${today.getDate().toString().padStart(2, "0")}`;
  // const date = "251121"
  let successfulLegRequests = 0;
  let totalRecordsInserted = 0;
  const gapPayloads: Parameters<typeof processGapData>[0] = [];

  for (const symbol of symbols) {
    const legPrices: Partial<
      Record<InstrumentLeg["leg"], { ltp: number; time: Date }>
    > = {};
    for (const leg of symbol.instruments) {
      try {

        await rateLimiter.waitForSlot();

        const response = await axios.get(
          `https://history.truedata.in/getticks?symbol=${leg.instrumentType}&bidask=1&from=${date}T09:00:00&to=${date}T15:30:00&response=json`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
            },
          }
        );

        if (response.data && response.data.status === "Success") {
          successfulLegRequests++;
          const recordsCount = response.data.Records
            ? response.data.Records.length
            : 0;

          if (recordsCount > 0) {
            const lastRecord = [
              response.data.Records[response.data.Records.length - 1],
            ];
            const ltp = Number(lastRecord[0][1]);
            const time = new Date(lastRecord[0][0]);
            if (!Number.isNaN(ltp)) {
              legPrices[leg.leg] = { ltp, time };
            }

            const transformedRecords = transformRecordsToDbFormat(
              lastRecord,
              leg.instrumentId
            );
            const insertedCount = await bulkInsertTicksData(transformedRecords);
            totalRecordsInserted += insertedCount;
            console.log(
              `?? Inserted ${insertedCount} records for ${leg.instrumentType} (instrumentId: ${leg.instrumentId})`
            );
          }
        } else {
          console.log(
            `?? Data fetch for ${leg.instrumentType} returned status: ${
              response.data?.status || "unknown"
            }`
          );
        }
      } catch (error: any) {
        console.error(
          `? Failed to fetch data for ${leg.instrumentType}:`,
          error.message
        );
      }
    }

    if (legPrices.near && legPrices.next && legPrices.far) {
      const gap_1 = legPrices.next.ltp - legPrices.near.ltp;
      const gap_2 = legPrices.far.ltp - legPrices.next.ltp;
      const timestamp = new Date(
        Math.max(
          legPrices.near.time.getTime(),
          legPrices.next.time.getTime(),
          legPrices.far.time.getTime()
        )
      );

      gapPayloads.push({
        instrumentId: symbol.symbolId,
        instrumentName: symbol.instruments[0].instrumentType,
        gap_1,
        gap_2,
        price_1: legPrices.near.ltp,
        price_2: legPrices.next.ltp,
        price_3: legPrices.far.ltp,
        timestamp,
      });
    } else {
      console.warn(
        `? Missing leg data for symbolId ${symbol.symbolId}, skipping gap calculation`
      );
    }
  }

  if (gapPayloads.length > 0) {
    try {
      await processGapData(gapPayloads);
      console.log(`?? Processed ${gapPayloads.length} gap calculations`);
    } catch (error: any) {
      console.error("? Failed to process gap data:", error.message);
    }
  }

  return {
    processedSymbols: symbols.length,
    successfulLegRequests,
    totalRecordsInserted,
    gapsEvaluated: gapPayloads.length,
  };
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
    gapsEvaluated?: number;
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
        subject = "?? Hourly NSE Futures ticks Data Job Started";
        textContent = `Hourly NSE Futures ticks data job started at ${timeString}`;
        htmlContent = `
          <h2>?? Hourly NSE Futures ticks Data Job Started</h2>
          <p><strong>Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> Job initialization successful</p>
          <p>Starting data fetch for NSE_FUT instruments...</p>
        `;
        break;

      case "completed":
        subject = "? Hourly NSE Futures ticks Data Job Completed Successfully";
        textContent = `Hourly NSE Futures ticks data job completed successfully at ${timeString}.
        Instruments processed: ${details.instrumentsCount || 0}
        Successful responses: ${details.successfulCount || 0}
        Total records inserted: ${details.totalRecordsInserted || 0}
        Gaps evaluated: ${details.gapsEvaluated || 0}`;
        htmlContent = `
          <h2>? Hourly NSE Futures ticks Data Job Completed</h2>
          <p><strong>Completion Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ? Success</p>
          <hr>
          <h3>?? Results Summary:</h3>
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
            <li><strong>Gaps Evaluated:</strong> ${
              details.gapsEvaluated || 0
            }</li>
          </ul>
          <p><em>Data successfully stored in ticksFODataNSE table.</em></p>
        `;
        break;

      case "failed":
        subject = "? Hourly NSE Futures ticks Data Job Failed";
        textContent = `Hourly NSE Futures ticks data job failed at ${timeString}. Error: ${details.errorMessage}`;
        htmlContent = `
          <h2>? Hourly NSE Futures ticks Data Job Failed</h2>
          <p><strong>Failure Time:</strong> ${timeString}</p>
          <p><strong>Status:</strong> ? Failed</p>
          <hr>
          <h3>?? Error Details:</h3>
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

    console.log(`?? Email notification sent: ${status}`);
  } catch (error: any) {
    console.error(`? Failed to send email notification:`, error.message);
  }
}

/**
 * Main function to execute the hourly job
 */
async function executeHourlyJob(): Promise<void> {
  const startTime = Date.now();

  try {
    updateJobStatus("hourlyTicksNseFutJob", "running", CRON_EXPRESSION);

    const date = new Date();
    console.log(`?? Starting hourly NSE Futures job at ${date.toISOString()}`);

    await sendHourlyJobEmail("started", {});

    const loginSuccess = await fetchAccessToken();

    if (loginSuccess) {
      const symbols = await getNseInstruments();

      if (symbols.length > 0) {
        const result = await fetchHistoricalData(symbols);
        console.log(
          `?? Final Result: processed ${result.processedSymbols} symbols, ${result.successfulLegRequests} leg requests succeeded`
        );

        await sendHourlyJobEmail("completed", {
          instrumentsCount: result.processedSymbols,
          successfulCount: result.successfulLegRequests,
          totalRecordsInserted: result.totalRecordsInserted,
          gapsEvaluated: result.gapsEvaluated,
        });

        const duration = Date.now() - startTime;
        updateJobStatus(
          "hourlyTicksNseFutJob",
          "success",
          CRON_EXPRESSION,
          duration
        );
      } else {
        console.log("?? No instruments found, skipping historical data fetch");

        await sendHourlyJobEmail("completed", {
          instrumentsCount: 0,
          successfulCount: 0,
          totalRecordsInserted: 0,
          gapsEvaluated: 0,
        });

        const duration = Date.now() - startTime;
        updateJobStatus(
          "hourlyTicksNseFutJob",
          "success",
          CRON_EXPRESSION,
          duration
        );
      }
    } else {
      console.error("? Skipping instrument query due to login failure");

      await sendHourlyJobEmail("failed", {
        errorMessage: "Failed to fetch access token",
      });

      const duration = Date.now() - startTime;
      updateJobStatus(
        "hourlyTicksNseFutJob",
        "failed",
        CRON_EXPRESSION,
        duration,
        "Failed to fetch access token"
      );
    }

    console.log(
      `? Hourly NSE Futures job completed at ${new Date().toISOString()}`
    );
  } catch (error: any) {
    console.error("? Error in hourly NSE Futures job:", error.message);

    await sendHourlyJobEmail("failed", {
      errorMessage: error.message,
    });

    const duration = Date.now() - startTime;
    updateJobStatus(
      "hourlyTicksNseFutJob",
      "failed",
      CRON_EXPRESSION,
      duration,
      error.message
    );
  }
}

/**
 * Initialize the hourly NSE Futures job
 * Runs every every 5 min from 9 AM to 3 PM, Monday to Friday
 * Cron pattern: every 5 minutes from 9 through 15 on Monday through Friday (5-minute steps)
 */
export function initializeHourlyTicksNseFutJob(): void {
  initializeJobStatus("hourlyTicksNseFutJob", CRON_EXPRESSION);

  if (process.env.NODE_ENV === "development") {
    executeHourlyJob();
  }

  cron.schedule(CRON_EXPRESSION, executeHourlyJob, {
    timezone: "Asia/Kolkata",
  });

  console.log(
    "? Hourly NSE Futures job scheduled to run every 5 minutes from 9 AM to 3 PM, Monday to Friday (IST)"
  );
}
