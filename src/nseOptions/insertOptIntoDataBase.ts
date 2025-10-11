import { PrismaClient } from "@prisma/client";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { sendEmailNotification } from "../utils/sendEmail";
import { parseContract } from "./helper";
import { getNseOptionsHistory } from "./nseOptionsHistory";
import { createBatchInserter } from "../utils/batchInsert";

const prisma = new PrismaClient();

// Delay function to add pause between API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function insertOptIntoDataBase(date: any) {
  try {
    const dates = getDatesFromPastToToday(date);
    const batchInserter = createBatchInserter(prisma);

    for (let index = 0; index < dates.length; index++) {
      const date = dates[index];
      console.log("OPT api called ", date);
      const response = await getNseOptionsHistory(date);
      if (response == false) {
        console.log("skipped ", date);
      } else {
        // Collect all instruments, symbols, and options data
        const instrumentsToUpsert: Array<{ exchange: string; instrument_type: string }> = [];
        const symbolsToUpsert: Array<{
          symbol: string;
          instrument_type: string;
          expiry: Date;
          exchange: string;
          segment: string;
        }> = [];
        const optionsData: Array<any> = [];

        // Parse and collect all data
        for (const data of response.Records) {
          const symbol = parseContract(data[1]);
          if (symbol?.type !== "CE" && symbol?.type !== "PE") {
            continue;
          }

          // Collect instruments for batch upsert
          instrumentsToUpsert.push({
            exchange: "NSE",
            instrument_type: symbol?.instrument!,
          });

          // Collect symbols for batch upsert
          symbolsToUpsert.push({
            symbol: symbol?.symbol || data[1],
            instrument_type: symbol?.instrument!,
            expiry: new Date(symbol!.expiry),
            exchange: "NSE",
            segment: "OPT",
          });

          // Collect options data
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

        // Step 1: Batch upsert instruments
        if (instrumentsToUpsert.length > 0) {
          await batchInserter.batchUpsertInstruments(instrumentsToUpsert, {
            logProgress: true,
            chunkSize: 10,
          });
        }

        // Step 2: Batch upsert symbols
        if (symbolsToUpsert.length > 0) {
          await batchInserter.batchUpsertSymbolsList(symbolsToUpsert, {
            logProgress: true,
            chunkSize: 50,
          });
        }

        // Step 3: Batch insert options data
        if (optionsData.length > 0) {
          const result = await batchInserter.batchInsert(
            "nse_options",
            optionsData,
            async (chunk) => {
              return await prisma.nse_options.createMany({
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
            `📊 Options for ${date}: ${result.inserted} processed, ${result.errors} errors`
          );
        }
      }
    }
    console.log("✅ Completed all OPT data upload");
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
