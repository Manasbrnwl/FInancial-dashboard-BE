import { loadEnv } from "./env";

loadEnv();

export const UPSTOX_CONFIG = {
    API_KEY: process.env.UPSTOX_API_KEY || "",
    API_SECRET: process.env.UPSTOX_API_SECRET || "",
    REDIRECT_URI: process.env.UPSTOX_REDIRECT_URI || "http://localhost:3000/callback", // Default or configured
    BASE_URL: "https://api.upstox.com/v2",
};