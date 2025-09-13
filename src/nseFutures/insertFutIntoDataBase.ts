import { PrismaClient } from "../generated/prisma";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { sendEmailNotification } from "../utils/sendEmail";
import { parseContract } from "./helper";
import { getNseFuturesHistory } from "./nseFuturesHistory";

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
  for (let index = 0; index < dates.length; index++) {
    const date = dates[index];
    console.log("api called ", index);
    const response = await getNseFuturesHistory(date);

    // Add delay between API calls (1000ms = 1 second)
    if (index < dates.length - 1) {
      await delay(5000);
    }
    if (response == false) {
      console.log("skipped ", date);
    } else {
      for (const data of response.Records) {
        const symbol: symbolData | null = parseContract(data[1]);
        if (symbol?.type !== "FUT") {
          continue;
        }
        await prisma.instrument_lists.upsert({
          where: {
            exchange_instrument_type: {
              // 👈 compound unique key name
              exchange: "NSE_FUT",
              instrument_type: symbol?.instrument!,
            },
          },
          update: {}, // do nothing if found
          create: {
            exchange: "NSE_FUT",
            instrument_type: symbol?.instrument!,
          },
        });
        await prisma.nse_futures.create({
            data: {
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
                date: new Date(data[2])
            }
        })
      }
      console.log("uploaded all FO data");
    }
  }
    } catch (error: any) {
    await sendEmailNotification(
      process.env.RECEIVER_EMAIL || 'tech@anfy.in',
      "Finance Dashboard History Cron",
      `Error Uploading NSE Fut`,
      `<h1>Finance Dashboard History</h1><p>Cron have error <strong>${error}</strong></p><p>On uploading NSE Fut Data.</p>`
    );
    }
}

export { insertFutIntoDataBase };
