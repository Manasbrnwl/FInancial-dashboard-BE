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
    for (let i = 0; i < history.timestamp.length; i++) {
      const open = history.open[i];
      const high = history.high[i];
      const low = history.low[i];
      const close = history.close[i];
      const volume = history.volume[i];
      const ts = toISTDate(history.timestamp[i]);

      await prisma.bse_equity.create({
        data: {
          symbol_id: data.SECURITY_ID,
          symbol: data.SYMBOL_NAME,
          date: new Date(ts),
          open: open,
          close: close,
          high: high,
          low: low,
          volume: volume.toString(),
          oi: "0",
          exchange: "BSE",
        },
      });
    }
    console.log("data uploaded: ", data.INSTRUMENT_TYPE)
  } catch (error) {
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "Finance Dashboard History Cron",
      `Error Uploading NSE Opt`,
      `<h1>Finance Dashboard History</h1><p>Cron have error <strong>${error}</strong></p><p>On uploading NSE Opt Data.</p>`
    );
  }
}

export { insertBSEEqtIntoDataBase };
