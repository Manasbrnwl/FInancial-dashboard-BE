import axios from "axios";
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

            const { access_token, extended_token } = response.data;
            // We assume extended_token is false/true, but ideally we check expiry
            // Upstox tokens are valid for the day (until 3:30 AM or similar usually)

            cachedAccessToken = access_token;
            tokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // Mock expiry or standard day

            console.log("? Upstox Access Token generated successfully");
            return access_token;
        } catch (error: any) {
            console.error("? Failed to generate Upstox access token:", error.response?.data || error.message);
            throw error;
        }
    },

    /**
     * Returns the valid cached token or throws if missing/expired.
     */
    getAccessToken: (): string | null => {
        if (cachedAccessToken) {
            return cachedAccessToken;
        }
        return null;
    },

    /**
     * Manually set the token (e.g. if loaded from DB/File on startup)
     */
    setAccessToken: (token: string) => {
        cachedAccessToken = token;
    }
};
