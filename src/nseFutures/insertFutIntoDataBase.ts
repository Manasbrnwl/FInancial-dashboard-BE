import { PrismaClient } from "@prisma/client";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { sendEmailNotification } from "../utils/sendEmail";
import { parseContract } from "./helper";
import { getNseFuturesHistory } from "./nseFuturesHistory";
import { createBatchInserter } from "../utils/batchInsert";

const prisma = new PrismaClient();
const batchInserter = createBatchInserter(prisma);

// Delay function to add pause between API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface symbolData {
  symbol: string;
  instrument: string;
  expiry: string;
  type: string;
}

async function insertFutIntoDataBase(date: any) {
  try {
    const dates = getDatesFromPastToToday(date);
    for (let index = 0; index < dates.length; index++) {
      const date = dates[index];
      console.log("Fut api called ", date);
      const response = await getNseFuturesHistory(date);

      // Add delay between API calls (1000ms = 1 second)
      if (index < dates.length - 1) {
        await delay(5000);
      }
      if (response == false) {
        console.log("skipped ", date);
      } else {
        // Prepare data for optimized batch insertion
        const futuresData = [];
        const instrumentsData = [];
        const symbolsData = [];

        for (const data of response.Records) {
          const symbol: symbolData | null = parseContract(data[1]);
          if (symbol?.type !== "FUT") {
            continue;
          }

          // Collect instruments data
          instrumentsData.push({
            exchange: "NSE",
            instrument_type: symbol?.instrument!,
          });

          symbolsData.push({
            symbol: symbol?.symbol || data[1],
            instrument_type: symbol?.instrument!,
            exchange: "NSE",
            segment: "FUT",
          });

          futuresData.push({
            symbol_id: data[0].toString(),
            symbol: symbol?.symbol || data[1],
            expiry_date: new Date(symbol?.expiry),
            open: data[3],
            high: data[4],
            low: data[5],
            close: data[6],
            volume: data[7].toString(),
            oi: data[8].toString(),
            underlying: symbol?.instrument,
            date: new Date(data[2]),
          });
        }

        if (futuresData.length > 0) {
          // Batch upsert instruments efficiently
          await batchInserter.batchUpsertInstruments(instrumentsData);

          // Batch upsert symbols into symbols_list
          const symbolsResult = await batchInserter.batchUpsertSymbolsList(symbolsData, {
            chunkSize: 100,
            logProgress: true,
          });

          // Batch insert futures data with chunking and error handling
          const insertResult = await batchInserter.batchInsert(
            "nse_futures",
            futuresData,
            async (chunk) => {
              return await prisma.nse_futures.createMany({
                data: chunk,
                skipDuplicates: true,
              });
            },
            { chunkSize: 500, logProgress: true }
          );

          console.log(`📈 Futures batch for ${date}: ${insertResult.inserted} inserted, ${insertResult.errors} errors`);
          console.log(`📋 Symbols batch for ${date}: ${symbolsResult.inserted} inserted, ${symbolsResult.errors} errors`);
        }
        console.log("uploaded all FO data");
      }
    }
  } catch (error: any) {
    console.log("Future :", error);
    // await sendEmailNotification(
    //   process.env.RECEIVER_EMAIL || "tech@anfy.in",
    //   "Finance Dashboard History Cron",
    //   `Error Uploading NSE Fut`,
    //   `<h1>Finance Dashboard History</h1><p>Cron have error <strong>${error}</strong></p><p>On uploading NSE Fut Data.</p>`
    // );
  }
}

export { insertFutIntoDataBase };
