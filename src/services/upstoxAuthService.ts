import axios from "axios";
import { PrismaClient } from "@prisma/client";
import { UPSTOX_CONFIG } from "../config/upstoxConfig";

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
            const prisma = new PrismaClient(); // Instantiate or import singleton
            await prisma.app_config.upsert({
                where: { key: 'UPSTOX_ACCESS_TOKEN' },
                update: { value: access_token },
                create: { key: 'UPSTOX_ACCESS_TOKEN', value: access_token }
            });
            await prisma.$disconnect();

            cachedAccessToken = access_token;
            console.log("? Upstox Access Token generated and saved to DB");
            return access_token;
        } catch (error: any) {
            console.error("? Failed to generate Upstox access token:", error.response?.data || error.message);
            throw error;
        }
    },

    /**
     * Returns the valid cached token or throws if missing/expired.
     */
    getAccessToken: async (): Promise<string | null> => {
        // Try cache first (optional, but good for performance)
        // if (cachedAccessToken) return cachedAccessToken;

        // Fetch from DB
        try {
            const prisma = new PrismaClient();
            const config = await prisma.app_config.findUnique({
                where: { key: 'UPSTOX_ACCESS_TOKEN' }
            });
            await prisma.$disconnect();

            if (config?.value) {
                cachedAccessToken = config.value;
                return config.value;
            }
            return null;
        } catch (error: any) {
            console.error("? Failed to fetch token from DB:", error.message);
            return null;
        }
    },

    /**
     * Manually set the token (e.g. if loaded from DB/File on startup)
     */
    setAccessToken: async (token: string) => {
        cachedAccessToken = token;
        const prisma = new PrismaClient();
        await prisma.app_config.upsert({
            where: { key: 'UPSTOX_ACCESS_TOKEN' },
            update: { value: token },
            create: { key: 'UPSTOX_ACCESS_TOKEN', value: token }
        });
        await prisma.$disconnect();
    }
};

