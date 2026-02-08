import axios from "axios";
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { processCoveredCallData } from "../services/coveredCallAlertService";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { loadEnv } from "../config/env";

loadEnv();
const prisma = new PrismaClient();

const BATCH_SIZE = 500;

interface OptionInstrument {
    id: number;
    symbol: string;
    upstoxId: string;
    upstoxSymbol: string;
    instrumentId: number; // Underlying instrument_lists.id
    instrumentName: string;
    strike: number;
    optionType: string;
    expiryDate: Date;
    underlyingUpstoxId: string;
}

interface CoveredCallRow {
    instrumentId: number;
    instrumentName: string;
    symbol: string;
    strike: number;
    optionType: string;
    expiryDate: Date;
    underlyingPrice: number;
    premium: number;
}

/**
 * Fetch active CE options with their underlying equity Upstox IDs from DB.
 */
async function getActiveOptions(): Promise<OptionInstrument[]> {
    try {
        // Get CE options with active expiry and their underlying equity upstox_id
        const options = await prisma.$queryRaw<Array<{
            id: number;
            symbol: string;
            upstox_id: string;
            upstox_symbol: string;
            instrument_id: number;
            instrument_name: string;
            strike: string;
            option_type: string;
            expiry_date: Date;
            underlying_upstox_id: string;
        }>>`
      SELECT 
        sl.id,
        sl.symbol,
        sl.upstox_id,
        sl.upstox_symbol,
        sl.instrument_id,
        il.instrument_type AS instrument_name,
        sl.strike,
        sl.option_type,
        sl.expiry_date,
        il.upstox_id AS underlying_upstox_id
      FROM market_data.symbols_list sl
      JOIN market_data.instrument_lists il ON sl.instrument_id = il.id
      WHERE sl.segment = 'OPT'
        AND sl.expiry_date >= CURRENT_DATE
        AND sl.upstox_id IS NOT NULL
        AND il.upstox_id IS NOT NULL
        AND il.upstox_id LIKE 'NSE_EQ|IN%'
      ORDER BY sl.instrument_id, sl.strike::numeric
    `;

        return options.map(o => ({
            id: o.id,
            symbol: o.symbol,
            upstoxId: o.upstox_id,
            upstoxSymbol: o.upstox_symbol || o.symbol,
            instrumentId: o.instrument_id,
            instrumentName: o.instrument_name,
            strike: parseFloat(o.strike),
            optionType: o.option_type,
            expiryDate: new Date(o.expiry_date),
            underlyingUpstoxId: o.underlying_upstox_id,
        }));
    } catch (error: any) {
        console.error("❌ Failed to fetch active options from DB:", error.message);
        return [];
    }
}

/**
 * Fetch Market Quotes from Upstox for a batch of instrument keys.
 */
async function fetchQuotes(keys: string[], accessToken: string): Promise<Record<string, any> | null> {
    try {
        const url = `${UPSTOX_CONFIG.BASE_URL}/market-quote/quotes?instrument_key=${keys.join(",")}`;
        const response = await axios.get(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
                Accept: "application/json",
            },
        });

        if (response.data.status === "success") {
            return response.data.data;
        }
        return null;
    } catch (error: any) {
        console.error(
            "❌ Failed to fetch quotes batch:",
            error.response?.data?.errors || error.message
        );
        return null;
    }
}

/**
 * Fetch covered call candidates using Upstox API for real-time prices.
 */
async function getCoveredCallCandidates(accessToken: string): Promise<CoveredCallRow[]> {
    try {
        // 1. Get all active CE options with underlying info
        const options = await getActiveOptions();
        if (options.length === 0) {
            console.log("⚠️ No active CE options found.");
            return [];
        }

        console.log(`📊 Found ${options.length} active CE options. Fetching quotes...`);

        // 2. Collect unique underlying equity Upstox IDs
        const underlyingIds = [...new Set(options.map(o => o.underlyingUpstoxId))];
        console.log(`📊 Found ${underlyingIds.length} unique underlying equities.`);

        // 3. Fetch underlying equity quotes (for CMP)
        const equityQuotes: Record<string, number> = {};
        for (let i = 0; i < underlyingIds.length; i += BATCH_SIZE) {
            const batch = underlyingIds.slice(i, i + BATCH_SIZE);
            const quotes = await fetchQuotes(batch, accessToken);
            
            if (quotes) {
                for (const key of Object.keys(quotes)) {
                    const quote = quotes[key];
                    if (quote?.last_price) {
                        // Store by upstox_id (e.g., NSE_EQ|INE...)
                        const upstoxId = batch.find(id => key.includes(id.split("|")[1]) || key === `NSE_EQ:${quote.upstox_name}`);
                        if (upstoxId) {
                            equityQuotes[upstoxId] = quote.last_price;
                        }
                        // Also try to match by the key format returned by API
                        equityQuotes[key] = quote.last_price;
                    }
                }
            }
            await new Promise(r => setTimeout(r, 100));
        }

        console.log(`📊 Fetched ${Object.keys(equityQuotes).length} equity quotes.`);

        // 4. Fetch option quotes (for premium/LTP)
        const optionUpstoxIds = options.map(o => o.upstoxId);
        const optionQuotes: Record<string, number> = {};

        for (let i = 0; i < optionUpstoxIds.length; i += BATCH_SIZE) {
            const batch = optionUpstoxIds.slice(i, i + BATCH_SIZE);
            const quotes = await fetchQuotes(batch, accessToken);

            if (quotes) {
                for (const key of Object.keys(quotes)) {
                    const quote = quotes[key];
                    if (quote?.last_price) {
                        optionQuotes[key] = quote.last_price;
                        // Also map by upstox_id format
                        const matchingOpt = options.find(o =>
                            key.includes(o.upstoxSymbol) || key === `NSE_FO:${o.upstoxSymbol}`
                        );
                        if (matchingOpt) {
                            optionQuotes[matchingOpt.upstoxId] = quote.last_price;
                        }
                    }
                }
            }
            await new Promise(r => setTimeout(r, 100));
        }

        console.log(`📊 Fetched ${Object.keys(optionQuotes).length} option quotes.`);

        // 5. Build candidates by combining option metadata with live prices
        const candidates: CoveredCallRow[] = [];

        for (const opt of options) {
            // Get underlying price
            const underlyingPrice = equityQuotes[opt.underlyingUpstoxId] ||
                equityQuotes[`NSE_EQ:${opt.instrumentName}`] ||
                0;

            // Get option premium
            const premium = optionQuotes[opt.upstoxId] ||
                optionQuotes[`NSE_FO:${opt.upstoxSymbol}`] ||
                0;

            // Skip if missing data
            if (underlyingPrice <= 0 || premium <= 0) continue;

            // Only include OTM calls (strike > underlying)
            if (opt.strike <= underlyingPrice) continue;

            candidates.push({
                instrumentId: opt.id,
                instrumentName: opt.instrumentName,
                symbol: opt.symbol,
                strike: opt.strike,
                optionType: opt.optionType,
                expiryDate: opt.expiryDate,
                underlyingPrice,
                premium,
            });
        }

        console.log(`✅ Built ${candidates.length} covered call candidates with live prices.`);
        return candidates;
    } catch (error: any) {
        console.error("❌ Failed to fetch covered call candidates:", error.message);
        return [];
    }
}

/**
 * Main execution function for the 5-minute covered call alert job.
 */
export async function executeCoveredCallAlertJob() {
    const startTime = Date.now();
    console.log(`⏰ Starting Covered Call Alert Job at ${new Date().toISOString()}`);

    try {
        // 1. Get Upstox Access Token
        const token = await upstoxAuthService.getAccessToken();
        if (!token) {
            console.error("❌ No Upstox Access Token available. Skipping job.");
            return;
        }

        // 2. Fetch candidates using Upstox API
        const candidates = await getCoveredCallCandidates(token);

        if (candidates.length === 0) {
            console.log("⚠️ No covered call candidates found.");
            return;
        }

        console.log(`📊 Processing ${candidates.length} covered call candidates...`);

        // 3. Process through alert service
        await processCoveredCallData(
            candidates.map(c => ({
                instrumentId: c.instrumentId,
                instrumentName: c.instrumentName,
                symbol: c.symbol,
                strike: c.strike,
                optionType: c.optionType,
                expiryDate: c.expiryDate,
                underlyingPrice: c.underlyingPrice,
                premium: c.premium,
                timestamp: new Date(),
            }))
        );

        const duration = (Date.now() - startTime) / 1000;
        console.log(`✅ Covered Call Alert Job Completed in ${duration.toFixed(2)}s.`);
    } catch (error: any) {
        console.error("❌ Critical Error in Covered Call Alert Job:", error.message);
    }
}

/**
 * Initialize the cron job.
 */
export function initializeCoveredCallAlertJob(): void {
    // Run every 5 minutes from 9:15 AM to 3:30 PM (Mon-Fri)
    const schedule = "*/5 9-15 * * 1-5";

    cron.schedule(schedule, executeCoveredCallAlertJob, {
        timezone: "Asia/Kolkata",
    });

    console.log(`📢 Covered Call Alert Job Scheduled (${schedule})`);

    // Optional: Run once on start for DEV verification
    if (process.env.NODE_ENV === "development") {
        executeCoveredCallAlertJob();
    }
}
