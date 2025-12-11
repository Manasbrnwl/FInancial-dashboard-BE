import { PrismaClient } from "@prisma/client";
import { upstoxInstrumentService } from "../services/upstoxInstrumentService";
import { loadEnv } from "../config/env";

loadEnv();
const prisma = new PrismaClient();

export async function syncUpstoxIds(): Promise<void> {
    try {
        console.log("? Syncing Upstox IDs to database...");

        // 1. Load latest instruments from Upstox
        await upstoxInstrumentService.loadInstruments();

        // 2. Fetch all symbols with missing upstox_id
        // Note: 'market_data' schema is handled by Prisma via model mapping, 
        // simply querying the model 'symbols_list' should work.
        const missingSymbols = await prisma.symbols_list.findMany({
            where: {
                upstox_id: null,
                expiry_date: {
                    gte: new Date()
                },
                segment: 'OPT'
            },
            select: {
                id: true,
                symbol: true,
            }
        });

        if (missingSymbols.length === 0) {
            console.log("? No symbols missing upstox_id. Sync complete.");
            return;
        }

        console.log(`? Found ${missingSymbols.length} symbols missing upstox_id. Processing...`);

        let updatedCount = 0;

        // 3. Process each symbol
        for (const item of missingSymbols) {
            const key = upstoxInstrumentService.getInstrumentKey(item.symbol);

            if (key) {
                await prisma.symbols_list.update({
                    where: { id: item.id },
                    data: { upstox_id: key }
                });
                updatedCount++;
            }
        }

        console.log(`? Successfully synced ${updatedCount} / ${missingSymbols.length} Upstox IDs.`);

    } catch (error: any) {
        console.error("? Failed to sync Upstox IDs:", error.message);
    }
}
