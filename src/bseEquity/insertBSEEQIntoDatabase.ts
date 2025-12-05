import { PrismaClient } from "@prisma/client";
import { sendEmailNotification } from "../utils/sendEmail";

const prisma = new PrismaClient();

function toISTDate(timestamp: any) {
  // Convert seconds → milliseconds
  const date = new Date(timestamp * 1000);

  // Format to YYYY-MM-DD in IST
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata", // IST
  });
}

// Delay function to add pause between API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function insertBSEEqtIntoDataBase(
  data: any,
  history: {
    open: number[];
    high: number[];
    low: number[];
    close: number[];
    volume: number[];
    timestamp: number[];
  }
) {
  try {
    // Prepare all records for batch insertion
    const records = [];

    for (let i = 0; i < history.timestamp.length; i++) {
      const ts = toISTDate(history.timestamp[i]);

      records.push({
        symbol_id: data.SECURITY_ID,
        symbol: data.SYMBOL_NAME,
        date: new Date(ts),
        open: history.open[i],
        close: history.close[i],
        high: history.high[i],
        low: history.low[i],
        volume: history.volume[i].toString(),
        oi: "0",
        exchange: "BSE",
      });
    }

    // Batch insert all records at once
    if (records.length > 0) {
      const result = await prisma.bse_equity.createMany({
        data: records,
        skipDuplicates: true,
      });

      return {
        inserted: result.count,
        total: records.length,
      };
    }

    return {
      inserted: 0,
      total: 0,
    };
  } catch (error: any) {
    console.error(`❌ Error inserting BSE data for ${data.SYMBOL_NAME}:`, error.message);
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "Finance Dashboard History Cron",
      `Error Uploading BSE Equity`,
      `<h1>Finance Dashboard History</h1><p>Cron encountered error: <strong>${error.message}</strong></p><p>On uploading BSE Equity Data for ${data.SYMBOL_NAME}.</p>`
    );
    throw error;
  }
}

export { insertBSEEqtIntoDataBase };