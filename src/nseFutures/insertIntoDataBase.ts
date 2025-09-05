import { PrismaClient } from "../generated/prisma";
import { getDatesFromPastToToday } from "../utils/dateRange";
import { parseContract } from "./helper";
import { getNseFuturesHistory } from "./nseFuturesHistory";

const prisma = new PrismaClient();

async function insertIntoDataBase(date: any) {
    console.log(date)
    const dates = getDatesFromPastToToday(date)
console.log(dates) 
return;

    dates.map(async (date: string) => {
        const response = await getNseFuturesHistory(date);
        for (const data of response) {
            const symbol = parseContract(data[1])
            if (symbol?.type !== "FUT") {
                continue;
            }
            await prisma.instrument_lists.upsert({
                where: {
                    exchange_instrument_type: {   // 👈 compound unique key name
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
                    symbol_id: data[0],
                    symbol: symbol?.symbol || data[1],
                    expiry_date: symbol?.expiry,
                    open: data[3],
                    high: data[4],
                    low: data[5],
                    close: data[6],
                    volume: data[8],
                    oi: data[9],
                    underlying: symbol?.instrument,
                    date: data[2]
                }
            })

        }
    })
}

export {insertIntoDataBase}