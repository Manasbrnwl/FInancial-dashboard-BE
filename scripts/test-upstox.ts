
import dotenv from "dotenv";
import path from "path";

// Load environment variables from the root .env file
dotenv.config({ path: path.resolve(__dirname, "../.env") });

import { upstoxInstrumentService } from "../src/services/upstoxInstrumentService";
import { upstoxAuthService } from "../src/services/upstoxAuthService";
import { UPSTOX_CONFIG } from "../src/config/upstoxConfig";

async function runTest() {
    console.log("🚀 Starting Upstox API Verification Test...\n");

    // 1. Verify Configuration
    console.log("1️⃣ Verifying Configuration...");
    if (!UPSTOX_CONFIG.API_KEY || !UPSTOX_CONFIG.API_SECRET) {
        console.error("❌ Missing Upstox API Credentials in .env");
        process.exit(1);
    }
    console.log("✅ API Key present:", UPSTOX_CONFIG.API_KEY.substring(0, 4) + "****");
    console.log("✅ Redirect URI:", UPSTOX_CONFIG.REDIRECT_URI);
    console.log("\n");

    // 2. Test Instrument Download (Public Endpoint)
    console.log("2️⃣ Testing Instrument Download (Public Endpoint)...");
    try {
        await upstoxInstrumentService.loadInstruments();

        // Quick verification of the map
        const testSymbol = "NIFTY"; // Just a partial check
        // We can't access the private map directly, but we can try getInstrumentKey
        // Ideally upstoxInstrumentService should expose a way to check size or strict match
        // But loadInstruments prints logs, which we can observe.

        console.log("✅ Instrument download function executed without throwing errors.\n");
    } catch (error: any) {
        console.error("❌ Instrument download failed:", error.message);
    }

    // 3. Test Auth URL Generation
    console.log("3️⃣ Testing Login URL Generation...");
    try {
        const loginUrl = upstoxAuthService.getLoginUrl();
        console.log("✅ Generated Login URL:");
        console.log(loginUrl);
        console.log("\n👉 Please visit this URL in your browser to generate a code if you need to login manually.");
        console.log("\n");
    } catch (error: any) {
        console.error("❌ Failed to generate Login URL:", error.message);
    }

    console.log("🏁 Test Complete.");
}

runTest().catch(console.error);
