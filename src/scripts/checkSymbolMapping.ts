import { PrismaClient } from "@prisma/client";
import { upstoxInstrumentService } from "../services/upstoxInstrumentService";
import { loadEnv } from "../config/env";

loadEnv();
const prisma = new PrismaClient();

async function main() {
    console.log("? Starting Symbol Verification...");

    // 1. Load Upstox Instruments
    await upstoxInstrumentService.loadInstruments();

    // 2. Fetch Sample Symbols from DB (TrueData format)
    const samples = await prisma.$queryRaw<Array<{ symbol: string }>>`
    select symbol from market_data.symbols_list 
    where segment = 'OPT' and expiry_date >= CURRENT_DATE and symbol like 'NIFTY%'
    limit 1
  `;

    if (samples.length === 0) {
        console.log("? No active option symbols found in DB.");
        return;
    }

    console.log(`? Verifying ${samples.length} symbols...`);

    let matches = 0;
    let mismatches = 0;

    for (const row of samples) {
        const dbSymbol = row.symbol; // e.g., NIFTY23DEC19000CE

        // Direct lookup
        let key = upstoxInstrumentService.getInstrumentKey(dbSymbol);

        // If fail, try normalization prototype
        // TrueData: NIFTY23DEC19000CE
        // Upstox Expected (Likely): NIFTY 19000 CE 21 DEC 23 (Need to confirm logic)
        // NOTE: Upstox tradingsymbol in the CSV might be different from the API response format.
        // The CSV usually contains "NIFTY 19000 CE 21 DEC 23" style.

        if (!key) {
            console.log(`? Mismatch: ${dbSymbol} -> Not found`);
            mismatches++;
        } else {
            console.log(`? Match: ${dbSymbol} -> ${key}`);
            matches++;
        }
    }

    console.log("\n--- Report ---");
    console.log(`Total: ${samples.length}`);
    console.log(`Matches: ${matches}`);
    console.log(`Mismatches: ${mismatches}`);

    if (mismatches > 0) {
        console.log("\n? Recommendation: Implementation of symbol normalization is required.");
    }
}

main()
    .catch((e) => console.error(e))
    .finally(async () => {
        await prisma.$disconnect();
    });
