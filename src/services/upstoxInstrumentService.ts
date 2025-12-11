import axios from "axios";
import zlib from "zlib";
import { promisify } from "util";

const gunzip = promisify(zlib.gunzip);

// Map: Trading Symbol -> Instrument Key
// Example: "NIFTY23DEC19000CE" -> "NSE_FO|12345"
let symbolKeyMap = new Map<string, string>();

export const upstoxInstrumentService = {
    /**
     * Downloads and parses the Upgrade Instruments Master CSV.
     * Updates the in-memory map.
     */
    loadInstruments: async (): Promise<void> => {
        try {
            console.log("? Downloading Upstox Instruments Master...");
            const response = await axios.get("https://assets.upstox.com/market-quote/instruments/exchange/NSE.csv.gz", {
                responseType: "arraybuffer",
            });

            console.log("? Decompressing instruments file...");
            const csvBuffer = await gunzip(response.data);
            const csvData = csvBuffer.toString("utf-8");

            console.log("? Parsing instruments...");
            const lines = csvData.split("\n");
            const tempMap = new Map<string, string>();

            // Header: instrument_key,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,isin,exchange
            // We need index of: instrument_key (0), tradingsymbol (2)
            // Note: CSV format is stable but verifying headers is good practice. 
            // For performance/simplicity, we assume standard position as per docs.

            let count = 0;
            for (const line of lines) {
                if (!line.trim()) continue;
                const cols = line.split(",");

                // Skip header if strictly checking, or simple logic:
                if (cols[0] === "instrument_key") continue;

                const instrumentKey = cols[0].replace(/"/g, "");
                const tradingSymbol = cols[2].replace(/"/g, "");

                if (instrumentKey && tradingSymbol) {
                    tempMap.set(tradingSymbol.trim(), instrumentKey.trim());
                    count++;
                }
            }

            symbolKeyMap = tempMap;
            console.log(`? Loaded ${count} instruments from Upstox.`);

            // DEBUG: Find NIFTY keys
            let i = 0;
            for (const k of tempMap.keys()) {
                if (k.startsWith("NIFTY")) {
                    i++;
                    if (i > 100 && i < 120) {
                        console.log(`Debug Key [${i}]: ${k}`);
                    }
                    if (i > 120) break;
                }
            }
        } catch (error: any) {
            console.error("? Failed to load Upstox instruments:", error.message);
        }
    },

    /**
   * Get Upstox Instrument Key for a given trading symbol.
   * Handles TrueData -> Upstox format normalization.
   * TrueData: NIFTY25123030000PE (YYMMDD)
   * Upstox:   NIFTY25DEC30000PE (YYMMM) - Assuming monthly
   */
    getInstrumentKey: (symbol: string): string | undefined => {
        // 1. Direct match
        if (symbolKeyMap.has(symbol)) return symbolKeyMap.get(symbol);

        // 2. Normalization Strategy
        // Regex: Symbol(Group 1) + YY(2) + MM(3) + DD(4) + Strike(5) + Type(6)
        // e.g. NIFTY 25 12 30 30000 PE
        const regex = /^([A-Z]+)(\d{2})(\d{2})(\d{2})(\d+)([A-Z]{2})$/;
        const match = symbol.match(regex);

        if (match) {
            const [_, name, yy, mm, dd, strike, type] = match;
            const monthMap: { [key: string]: string } = {
                "01": "JAN", "02": "FEB", "03": "MAR", "04": "APR", "05": "MAY", "06": "JUN",
                "07": "JUL", "08": "AUG", "09": "SEP", "10": "OCT", "11": "NOV", "12": "DEC"
            };

            const mmm = monthMap[mm];
            if (mmm) {
                // Strategy A: Construct "Monthly" format (NIFTY25DEC30000PE)
                const monthlySymbol = `${name}${yy}${mmm}${strike}${type}`;
                if (symbolKeyMap.has(monthlySymbol)) return symbolKeyMap.get(monthlySymbol);

                // Strategy B: Construct "Weekly" format (NIFTY25DEC3030000PE)
                // Check if map has Symbol + YY + MMM + DD + Strike + Type
                const weeklySymbol = `${name}${yy}${mmm}${dd}${strike}${type}`;
                if (symbolKeyMap.has(weeklySymbol)) return symbolKeyMap.get(weeklySymbol);
            }
        }

        return undefined;
    }
};
