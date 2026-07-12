// Thin wrapper around the shared Bhavcopy sync logic in src/scripts/fetchHistoricalSymbols.ts.
// Run via: npx ts-node scripts/fetch-historical-symbols.ts
import { syncHistoricalSymbols } from "../src/scripts/fetchHistoricalSymbols";
import prisma from "../src/config/prisma";

// Flag to prevent database mutations
const DRY_RUN = false;

// Date range config
const START_DATE = "2026-06-20";
const END_DATE = new Date().toISOString().split("T")[0];

syncHistoricalSymbols(START_DATE, END_DATE, DRY_RUN)
    .then(async () => {
        await prisma.$disconnect();
    })
    .catch(async (e) => {
        console.error(`💥 Critical Execution Failure:`, e);
        await prisma.$disconnect();
        process.exit(1);
    });
