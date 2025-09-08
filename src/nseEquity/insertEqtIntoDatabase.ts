import { PrismaClient } from "../generated/prisma";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { getNseOptionsHistory } from "./nseEquityHistory";

const prisma = new PrismaClient();

// Delay function to add pause between API calls
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function insertEqIntoDataBase(date: any) {
  const dates = getDatesFromPastToToday(date);
  for (let index = 0; index < dates.length; index++) {
    const date = dates[index];
    console.log("api called ", date);
    const response = await getNseOptionsHistory(date);
    // Add delay between API calls (1000ms = 1 second)
    // if (index < dates.length - 1) {
    //     await delay(5000);
    // }
    if (response == false) {
      console.log("skipped ", date);
    } else {
      for (const data of response.Records) {
        await prisma.instrument_lists.upsert({
          where: {
            exchange_instrument_type: {
              // 👈 compound unique key name
              exchange: "NSE_EQ",
              instrument_type: data[1],
            },
          },
          update: {}, // do nothing if found
          create: {
            exchange: "NSE_EQ",
            instrument_type: data[1],
          },
        });
        try {
          await prisma.nse_equity.create({
            data: {
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
            },
          });
        } catch (err: any) {
          if (err.code === "P2002") {
            console.log("Duplicate entry skipped:", data[1], data[2]);
          } else {
            throw err;
          }
        }
      }
      console.log("uploaded all EQ data");
    }
  }
}

export { insertEqIntoDataBase };
