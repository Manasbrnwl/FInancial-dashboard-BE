import axios from "axios";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { devLog, devError, prodError } from "../utils/errorLogger";

// OHLC data structure from Upstox V3 API
export interface OhlcCandle {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    ts: string; // Timestamp
}

export interface OhlcQuote {
    instrument_token: string;
    last_price: number;
    live_ohlc?: OhlcCandle;
    prev_ohlc?: OhlcCandle;
}

export interface OhlcResponse {
    [key: string]: OhlcQuote;
}

// Batch size for Upstox Quote API
const BATCH_SIZE = 500;

/**
 * Upstox OHLC V3 Service
 * Fetches OHLC data using the /v3/market-quote/ohlc endpoint
 */
export const upstoxOhlcService = {
    /**
     * Fetch OHLC data for a batch of instrument keys
     * @param instrumentKeys Array of instrument keys (e.g., ["NSE_EQ|INE848E01016"])
     * @param accessToken Upstox access token
     * @param interval OHLC interval: "1d" (daily), "I1" (1-min), "I30" (30-min)
     * @returns OHLC data mapped by instrument key
     */
    fetchOhlc: async (
        instrumentKeys: string[],
        accessToken: string,
        interval: string = "1d"
    ): Promise<OhlcResponse | null> => {
        try {
            if (instrumentKeys.length === 0) {
                return null;
            }

            const url = `${UPSTOX_CONFIG.BASE_URL_V3}/market-quote/ohlc`;
            const response = await axios.get(url, {
                params: {
                    instrument_key: instrumentKeys.join(","),
                    interval: interval,
                },
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    Accept: "application/json",
                },
            });

            if (response.data.status === "success") {
                return response.data.data;
            }

            devError("❌ Upstox OHLC V3 API returned non-success status:", response.data.status);
            prodError("Upstox OHLC API returned non-success status");
            return null;
        } catch (error: any) {
            const errorData = error.response?.data?.errors;
            const isInvalidSymbolError = errorData?.some((e: any) =>
                e.errorCode?.startsWith("UDAPI") || e.message?.toLowerCase().includes("invalid symbol")
            );

            // A single stale/delisted instrument key 400s the whole batch. Isolate
            // it by splitting instead of silently dropping every instrument in the
            // batch for the day - this previously zeroed out all equity spot data
            // whenever one instrument_lists row had a bad upstox_id.
            if (isInvalidSymbolError && instrumentKeys.length > 1) {
                devLog(`⚠️ Invalid symbol detected in OHLC batch of ${instrumentKeys.length}. Splitting and retrying...`);

                const mid = Math.floor(instrumentKeys.length / 2);
                const left = instrumentKeys.slice(0, mid);
                const right = instrumentKeys.slice(mid);

                const [leftResult, rightResult] = await Promise.all([
                    upstoxOhlcService.fetchOhlc(left, accessToken, interval),
                    upstoxOhlcService.fetchOhlc(right, accessToken, interval),
                ]);

                return { ...(leftResult || {}), ...(rightResult || {}) };
            }

            if (isInvalidSymbolError && instrumentKeys.length === 1) {
                devError(`❌ Instrument ${instrumentKeys[0]} is invalid/delisted for OHLC and will be skipped.`);
                return null;
            }

            devError(
                "❌ Failed to fetch OHLC data:",
                error.response?.data?.errors || error.message
            );
            prodError("Failed to fetch OHLC data");
            return null;
        }
    },

    /**
     * Fetch OHLC data in batches for large instrument lists
     * @param instrumentKeys Array of all instrument keys
     * @param accessToken Upstox access token
     * @param interval OHLC interval
     * @param onBatchComplete Optional callback after each batch
     * @returns Combined OHLC data for all instruments
     */
    fetchOhlcBatched: async (
        instrumentKeys: string[],
        accessToken: string,
        interval: string = "1d",
        onBatchComplete?: (batchIndex: number, totalBatches: number) => void
    ): Promise<OhlcResponse> => {
        const allData: OhlcResponse = {};
        const totalBatches = Math.ceil(instrumentKeys.length / BATCH_SIZE);

        for (let i = 0; i < instrumentKeys.length; i += BATCH_SIZE) {
            const batchKeys = instrumentKeys.slice(i, i + BATCH_SIZE);
            const batchIndex = Math.floor(i / BATCH_SIZE) + 1;

            const batchData = await upstoxOhlcService.fetchOhlc(batchKeys, accessToken, interval);

            if (batchData) {
                Object.assign(allData, batchData);
            }

            if (onBatchComplete) {
                onBatchComplete(batchIndex, totalBatches);
            }

            // Small delay between batches to avoid rate limiting
            if (i + BATCH_SIZE < instrumentKeys.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }

        return allData;
    },

    /**
     * Extract daily OHLC values from response
     * Uses prev_ohlc for completed day data or live_ohlc for current day
     */
    extractDailyOhlc: (quote: OhlcQuote): {
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        timestamp: Date | null;
    } | null => {
        // Prefer prev_ohlc for completed candle, fallback to live_ohlc
        const ohlc = quote.prev_ohlc || quote.live_ohlc;

        if (!ohlc) {
            return null;
        }

        return {
            open: ohlc.open,
            high: ohlc.high,
            low: ohlc.low,
            close: ohlc.close,
            volume: ohlc.volume,
            timestamp: ohlc.ts ? new Date(ohlc.ts) : null,
        };
    },
};
