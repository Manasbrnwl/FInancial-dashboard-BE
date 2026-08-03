import { upstoxInstrumentService } from "../services/upstoxInstrumentService";
import { loadEnv } from "../config/env";
import prisma from "../config/prisma";

loadEnv();

/**
 * Refreshes symbols_list.upstox_id for FUT/OPT contracts from Upstox's current
 * instrument master. Upstox recycles NSE_FO exchange tokens across expiries, so
 * a upstox_id captured at one point in time silently goes stale ("Invalid
 * Instrument key" on every historical-candle call) once Upstox reissues it.
 * loadNseFutInstruments/loadNseOptInstruments re-match by (instrument_id, symbol)
 * rather than trusting the old token, so this is safe to re-run any time.
 *
 * Nothing in the running app currently calls these two functions (only the
 * lighter-weight loadValidNseInstrumentKeys, which filters stale keys out of
 * the equity job rather than fixing them) -- that's the root cause of the
 * near-100% "Invalid Instrument key" failures seen backfilling nse_futures.
 *
 * Usage: npx ts-node src/scripts/refreshUpstoxInstrumentKeys.ts
 */
async function main(): Promise<void> {
    console.log("Refreshing FUT instrument keys from Upstox master...");
    await upstoxInstrumentService.loadNseFutInstruments();

    console.log("Refreshing OPT instrument keys from Upstox master...");
    await upstoxInstrumentService.loadNseOptInstruments();

    console.log("Done.");
}

main()
    .then(() => prisma.$disconnect())
    .catch(async (err) => {
        console.error("Refresh failed:", err);
        await prisma.$disconnect();
        process.exit(1);
    });
