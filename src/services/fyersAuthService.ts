import prisma from "../config/prisma";
import { FYERS_CONFIG } from "../config/fyersConfig";
import { devLog, devError, prodError } from "../utils/errorLogger";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fyersModel } = require("fyers-api-v3");

export const fyersAuthService = {
  /**
   * Exchanges the auth_code (from the /fyers callback) for an access token
   * and saves it to the DB, same as upstoxAuthService.generateAccessToken.
   */
  generateAccessToken: async (authCode: string): Promise<string> => {
    try {
      const fyers = new fyersModel({ enableLogging: false });
      fyers.setAppId(FYERS_CONFIG.APP_ID);
      fyers.setRedirectUrl(FYERS_CONFIG.REDIRECT_URI);

      const response = await fyers.generate_access_token({
        client_id: FYERS_CONFIG.APP_ID,
        secret_key: FYERS_CONFIG.APP_SECRET,
        auth_code: authCode,
      });

      if (response.s !== "ok" || !response.access_token) {
        throw new Error(response.message || "Fyers token exchange failed");
      }

      const accessToken = response.access_token;

      await prisma.app_config.upsert({
        where: { key: "FYERS_ACCESS_TOKEN" },
        update: { value: accessToken },
        create: { key: "FYERS_ACCESS_TOKEN", value: accessToken },
      });

      devLog("Fyers Access Token generated and saved to DB");
      return accessToken;
    } catch (error: any) {
      devError("Failed to generate Fyers access token:", error.message);
      prodError("Failed to generate Fyers access token");
      throw error;
    }
  },

  /**
   * Reads the stored Fyers access token from the DB (app_config table),
   * same as upstoxAuthService.getAccessToken.
   */
  getAccessToken: async (): Promise<string | null> => {
    try {
      const config = await prisma.app_config.findUnique({
        where: { key: "FYERS_ACCESS_TOKEN" },
      });
      return config?.value ?? null;
    } catch (error: any) {
      devError("Failed to fetch Fyers token from DB:", error.message);
      prodError("Failed to fetch Fyers token from DB");
      return null;
    }
  },
};
