import { PrismaClient } from "@prisma/client";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { sendEmailNotification } from "../utils/sendEmail";
import { parseContract } from "./helper";
import { getNseFuturesHistory } from "./nseFuturesHistory";
import { createBatchInserter } from "../utils/batchInsert";

const prisma = new PrismaClient();

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
    const batchInserter = createBatchInserter(prisma);

    for (let index = 0; index < dates.length; index++) {
      const date = dates[index];
      const response = await getNseFuturesHistory(date);
      if (response == false) {
        console.log("skipped ", date);
      } else {
        // Collect all instruments, symbols, and futures data
        const instrumentsToUpsert: Array<{ exchange: string; instrument_type: string }> = [];
        const symbolsToUpsert: Array<{
          symbol: string;
          instrument_type: string;
          expiry: Date;
          exchange: string;
          segment: string;
        }> = [];
        const futuresData: Array<any> = [];

        // Parse and collect all data
        for (const data of response.Records) {
          const symbol: symbolData | null = parseContract(data[1]);
          if (symbol?.type !== "FUT") {
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
            expiry: new Date(symbol?.expiry),
            exchange: "NSE",
            segment: "FUT",
          });

          // Collect futures data
          futuresData.push({
            symbol_id: data[0].toString(),
            symbol: symbol?.symbol.toString() || data[1].toString(),
            expiry_date: new Date(symbol?.expiry),
            open: data[3],
            high: data[4],
            low: data[5],
            close: data[6],
            volume: data[7].toString(),
            oi: data[8].toString(),
            underlying: symbol?.instrument.toString(),
            date: new Date(data[2]),
          });
        }

        // Step 1: Batch upsert instruments and get ID mappings
        let instrumentIdMap = new Map<string, number>();
        if (instrumentsToUpsert.length > 0) {
          instrumentIdMap = await batchInserter.batchUpsertInstruments(instrumentsToUpsert, {
            logProgress: true,
            chunkSize: 10,
          });
        }

        // Step 2: Batch upsert symbols and get ID mappings
        let symbolIdMap = new Map<string, number>();
        if (symbolsToUpsert.length > 0) {
          const result = await batchInserter.batchUpsertSymbolsList(symbolsToUpsert, {
            logProgress: true,
            chunkSize: 50,
          });
          symbolIdMap = result.symbolIdMap;
        }

        // Step 3: Map the IDs to the futures data
        const futuresDataWithIds = futuresData.map((fut) => ({
          ...fut,
          underlying: instrumentIdMap.get(fut.underlying)?.toString() || fut.underlying,
          symbol: symbolIdMap.get(fut.symbol)?.toString() || fut.symbol,
        }));

        // Step 4: Batch insert futures data with IDs
        if (futuresDataWithIds.length > 0) {
          const result = await batchInserter.batchInsert(
            "nse_futures",
            futuresDataWithIds,
            async (chunk) => {
              return await prisma.nse_futures.createMany({
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
            `📈 Futures for ${date}: ${result.inserted} processed, ${result.errors} errors`
          );
        }
      }
    }
    console.log("✅ Completed all FUT data upload");
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
