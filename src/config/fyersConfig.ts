import { loadEnv } from "./env";

loadEnv();

export const FYERS_CONFIG = {
  APP_ID: process.env.FYERS_APP_ID || "",
  APP_SECRET: process.env.FYERS_APP_SECRET || "",
  REDIRECT_URI: process.env.FYERS_REDIRECT_URI || "",
};
