import { PrismaClient } from "@prisma/client";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { sendEmailNotification } from "../utils/sendEmail";
import { parseContract } from "./helper";
import { getNseOptionsHistory } from "./nseOptionsHistory";
import { createBatchInserter } from "../utils/batchInsert";

const prisma = new PrismaClient();
const batchInserter = createBatchInserter(prisma);

// Delay function to add pause between API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function insertOptIntoDataBase(date: any) {
  try {
    const dates = getDatesFromPastToToday(date);
    for (let index = 0; index < dates.length; index++) {
      const date = dates[index];
      console.log("OPT api called ", date);
      const response = await getNseOptionsHistory(date);
      // Add delay between API calls (1000ms = 1 second)
      // if (index < dates.length - 1) {
      //     await delay(5000);
      // }
      if (response == false) {
        console.log("skipped ", date);
      } else {
        // Prepare data for optimized batch insertion
        const optionsData = [];
        const instrumentsData = [];

        for (const data of response.Records) {
          const symbol = parseContract(data[1]);
          if (symbol?.type !== "CE" && symbol?.type !== "PE") {
            continue;
          }

          // Collect instruments data based on option type
          const exchange = symbol?.type === "PE" ? "NSE_PE" : "NSE_CE";
          instrumentsData.push({
            exchange,
            instrument_type: symbol?.instrument!,
          });

          optionsData.push({
            symbol_id: data[0].toString(),
            symbol: symbol?.symbol || data[1],
            expiry_date: new Date(symbol!.expiry),
            open: data[3],
            high: data[4],
            low: data[5],
            close: data[6],
            volume: data[7].toString(),
            oi: data[8]?.toString(),
            underlying: symbol?.instrument,
            date: new Date(data[2]),
            strike: symbol?.strike,
            option_type: symbol?.type,
          });
        }

        if (optionsData.length > 0) {
          // Batch upsert instruments efficiently
          await batchInserter.batchUpsertInstruments(instrumentsData);

          // Batch insert options data with chunking and error handling
          const insertResult = await batchInserter.batchInsert(
            "nse_options",
            optionsData,
            async (chunk) => {
              return await prisma.nse_options.createMany({
                data: chunk,
                skipDuplicates: true,
              });
            },
            { chunkSize: 500, logProgress: true }
          );

          console.log(`📊 Options batch for ${date}: ${insertResult.inserted} inserted, ${insertResult.errors} errors`);
        }
        console.log("uploaded all OPT data");
      }
    }
  } catch (error) {
    console.log("Options : ", error);
    // await sendEmailNotification(
    //   process.env.RECEIVER_EMAIL || "tech@anfy.in",
    //   "Finance Dashboard History Cron",
    //   `Error Uploading NSE Opt`,
    //   `<h1>Finance Dashboard History</h1><p>Cron have error <strong>${error}</strong></p><p>On uploading NSE Opt Data.</p>`
    // );
  }
}

export { insertOptIntoDataBase };
