import { PrismaClient } from "@prisma/client";
import { sendEmailNotification } from "../utils/sendEmail";
import { createBatchInserter } from "../utils/batchInsert";

const prisma = new PrismaClient();

function toISTDate(timestamp: any) {
  // Convert seconds → milliseconds
  const date = new Date(timestamp * 1000);

  // Format to YYYY-MM-DD in IST
  return date.toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata", // IST
  });
}

async function insertBSEEqtIntoDataBase(
  instrumentData: any,
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
    const batchInserter = createBatchInserter(prisma);

    // Prepare all records for batch insertion
    const equityData: Array<any> = [];

    for (let i = 0; i < history.timestamp.length; i++) {
      const ts = toISTDate(history.timestamp[i]);

      equityData.push({
        symbol_id: instrumentData.SECURITY_ID,
        symbol: instrumentData.SYMBOL_NAME,
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

    // Batch insert with duplicate handling
    if (equityData.length > 0) {
      const result = await batchInserter.batchInsert(
        "bse_equity",
        equityData,
        async (chunk) => {
          return await prisma.bse_equity.createMany({
            data: chunk,
            skipDuplicates: true,
          });
        },
        {
          chunkSize: 1000,
          logProgress: true,
        }
      );

      console.log(
        `✅ BSE ${instrumentData.SYMBOL_NAME}: ${result.inserted} processed, ${result.errors} errors`
      );

      return result;
    }

    return { inserted: 0, errors: 0 };
  } catch (error: any) {
    console.error(`❌ Error inserting BSE data for ${instrumentData.SYMBOL_NAME}:`, error.message);
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "Finance Dashboard History Cron",
      `Error Uploading BSE Equity`,
      `<h1>Finance Dashboard History</h1><p>Cron encountered error: <strong>${error.message}</strong></p><p>On uploading BSE Equity Data for ${instrumentData.SYMBOL_NAME}.</p>`
    );
    throw error;
  }
}

export { insertBSEEqtIntoDataBase };
