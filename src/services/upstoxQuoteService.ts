import axios from "axios";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { devLog, devError, prodError } from "../utils/errorLogger";

/**
 * Resilient Quote Fetching Service
 * Handles Upstox API errors where a single invalid symbol can fail an entire batch.
 * Uses a recursive splitting strategy to isolate and skip invalid symbols.
 */
export const upstoxQuoteService = {
    /**
     * Fetch Market Quotes from Upstox for a batch of keys.
     * If a batch fails due to an invalid symbol (UDAPI1087), it splits and retries.
     */
    fetchQuotesResilient: async (keys: string[], accessToken: string): Promise<Record<string, any> | null> => {
        if (keys.length === 0) return {};

        try {
            const instrumentKeys = keys.map(encodeURIComponent).join(",");
            const url = `${UPSTOX_CONFIG.BASE_URL}/market-quote/quotes?instrument_key=${instrumentKeys}`;
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
            const errorData = error.response?.data?.errors;
            const isInvalidSymbolError = errorData?.some((e: any) => 
                e.errorCode === "UDAPI1087" || e.message?.toLowerCase().includes("invalid symbol")
            );

            // If it's an invalid symbol error and we have more than one key, split and retry
            if (isInvalidSymbolError && keys.length > 1) {
                devLog(`⚠️ Invalid symbol detected in batch of ${keys.length}. Splitting and retrying...`);
                
                const mid = Math.floor(keys.length / 2);
                const left = keys.slice(0, mid);
                const right = keys.slice(mid);
                
                // Fetch halves
                const [leftResult, rightResult] = await Promise.all([
                    upstoxQuoteService.fetchQuotesResilient(left, accessToken),
                    upstoxQuoteService.fetchQuotesResilient(right, accessToken)
                ]);

                return { ...(leftResult || {}), ...(rightResult || {}) };
            } 
            
            // If it's a single key that failed, just skip it and return null
            if (isInvalidSymbolError && keys.length === 1) {
                devError(`❌ Symbol ${keys[0]} is invalid/delisted and will be skipped.`);
                return null;
            }

            // Other errors (rate limits, network, etc.)
            devError(
                "❌ Failed to fetch quotes batch:",
                error.response?.data?.errors || error.message
            );
            prodError("Failed to fetch quotes batch");
            return null;
        }
    }
};
