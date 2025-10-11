import { PrismaClient } from "@prisma/client";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { sendEmailNotification } from "../utils/sendEmail";
import { getNseEquityHistory } from "./nseEquityHistory";
import { createBatchInserter } from "../utils/batchInsert";

const prisma = new PrismaClient();
const batchInserter = createBatchInserter(prisma);

// Delay function to add pause between API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function insertEqIntoDataBase(date: any) {
  try {
    const dates = getDatesFromPastToToday(date);
    for (let index = 0; index < dates.length; index++) {
      const date = dates[index];
      console.log("EQT api called ", date);
      const response = await getNseEquityHistory(date);
      if (response == false) {
        console.log("skipped ", date);
      } else {
        // Prepare data for optimized batch insertion
        const equityData = [];
        const instrumentsData = [];

        for (const data of response.Records) {
          // Collect instruments data
          instrumentsData.push({
            exchange: "NSE",
            instrument_type: data[1],
          });

          equityData.push({
            symbol_id: data[0].toString(),
            symbol: data[1],
            open: data[3],
            high: data[4],
            low: data[5],
            close: data[6],
            volume: data[7].toString(),
            oi: data[8]?.toString(),
            date: new Date(data[2]),
            exchange: "NSE",
          });
        }

        if (equityData.length > 0) {
          // Batch upsert instruments efficiently
          await batchInserter.batchUpsertInstruments(instrumentsData);

          // Batch insert equity data with chunking and error handling
          const insertResult = await batchInserter.batchInsert(
            "nse_equity",
            equityData,
            async (chunk) => {
              return await prisma.nse_equity.createMany({
                data: chunk,
                skipDuplicates: true,
              });
            },
            { chunkSize: 1000, logProgress: true }
          );

          console.log(`💼 Equity batch for ${date}: ${insertResult.inserted} inserted, ${insertResult.errors} errors`);
        }
        console.log("uploaded all EQ data");
      }
    }
  } catch (error: any) {
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || "tech@anfy.in",
      "Finance Dashboard History Cron",
      `Error Uploading NSE EQ`,
      `<h1>Finance Dashboard History</h1><p>Cron have error <strong>${error}</strong></p><p>On uploading NSE EQ Data.</p>`
    );
  }
}

export { insertEqIntoDataBase };
