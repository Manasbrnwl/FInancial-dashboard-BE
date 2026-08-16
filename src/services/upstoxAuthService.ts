import axios from "axios";
import prisma from "../config/prisma";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";
import { devLog, devError, prodError } from "../utils/errorLogger";

let cachedAccessToken: string | null = null;
let tokenExpiry: number | null = null;

export const upstoxAuthService = {
    /**
     * Generates the login URL for the user to authenticate.
     */
    getLoginUrl: (): string => {
        const params = new URLSearchParams({
            response_type: "code",
            client_id: UPSTOX_CONFIG.API_KEY,
            redirect_uri: UPSTOX_CONFIG.REDIRECT_URI,
            state: "init_upstox_auth", // Optional state
        });
        return `https://api.upstox.com/v2/login/authorization/dialog?${params.toString()}`;
    },


    /**
     * Exchanges the authorization code for an access token.
     */
    generateAccessToken: async (code: string): Promise<string> => {
        try {
            const params = new URLSearchParams();
            params.append("code", code);
            params.append("client_id", UPSTOX_CONFIG.API_KEY);
            params.append("client_secret", UPSTOX_CONFIG.API_SECRET);
            params.append("redirect_uri", UPSTOX_CONFIG.REDIRECT_URI);
            params.append("grant_type", "authorization_code");

            const response = await axios.post(
                `${UPSTOX_CONFIG.BASE_URL}/login/authorization/token`,
                params,
                {
                    headers: {
                        "Content-Type": "application/x-www-form-urlencoded",
                        Accept: "application/json",
                    },
                }
            );

            const { access_token } = response.data;

            // Save to Database
            await prisma.app_config.upsert({
                where: { key: 'UPSTOX_ACCESS_TOKEN' },
                update: { value: access_token },
                create: { key: 'UPSTOX_ACCESS_TOKEN', value: access_token }
            });

            cachedAccessToken = access_token;
            devLog("? Upstox Access Token generated and saved to DB");
            return access_token;
        } catch (error: any) {
            devError("? Failed to generate Upstox access token:", error.response?.data || error.message);
            prodError("Failed to generate Upstox access token");
            throw error;
        }
    },

    /**
     * Returns the stored token, or null if missing/unreadable.
     *
     * UPSTOX_ACCESS_TOKEN now holds an Analytics Token (switched 2026-08-16),
     * not a standard OAuth access token -- Analytics Tokens are read-only but
     * carry a 1-year validity and aren't tied to daily re-login, unlike the
     * standard token which expires at 3:30 AM IST every day regardless of
     * issue time. That's what the old 12-hour staleness check here was
     * guarding against; it doesn't apply to this token type and was actively
     * harmful for it (would reject a token that's still genuinely valid for
     * up to a year). If Upstox ever rejects this token outright (expired,
     * revoked, regenerated elsewhere), that surfaces as a real 401 from the
     * API call itself, same as any other invalid-token case.
     */
    getAccessToken: async (): Promise<string | null> => {
        try {
            const config = await prisma.app_config.findUnique({
                where: { key: 'UPSTOX_ACCESS_TOKEN' }
            });

            if (!config?.value) return null;

            cachedAccessToken = config.value;
            return config.value;
        } catch (error: any) {
            devError("? Failed to fetch token from DB:", error.message);
            prodError("Failed to fetch Upstox token from DB");
            return null;
        }
    },

    /**
     * Manually set the token (e.g. if loaded from DB/File on startup)
     */
    setAccessToken: async (token: string) => {
        cachedAccessToken = token;
        await prisma.app_config.upsert({
            where: { key: 'UPSTOX_ACCESS_TOKEN' },
            update: { value: token },
            create: { key: 'UPSTOX_ACCESS_TOKEN', value: token }
        });
    }
};

