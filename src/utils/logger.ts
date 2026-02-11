const isProduction = process.env.NODE_ENV === "production";

/**
 * Centralized logger that suppresses info/debug logs in production.
 * - info / debug: only log in development
 * - warn / error: always log (operational awareness)
 */
export const logger = {
    /** General informational messages — suppressed in production */
    info: (...args: any[]) => {
        if (!isProduction) console.log(...args);
    },

    /** Verbose debug output — suppressed in production */
    debug: (...args: any[]) => {
        if (!isProduction) console.log(...args);
    },

    /** Warnings — always logged */
    warn: (...args: any[]) => {
        console.warn(...args);
    },

    /** Errors — always logged server-side (never exposed to client) */
    error: (...args: any[]) => {
        console.error(...args);
    },
};
