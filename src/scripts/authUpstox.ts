import express from "express";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { loadEnv } from "../config/env";
import { logger } from "../utils/logger";

loadEnv();

const app = express();
const PORT = 3000;

async function startAuth() {
    // 1. Start Server
    const server = app.listen(PORT, () => {
        logger.info(`\n?? Auth Server running on http://localhost:${PORT}`);

        // 2. Generate and Print Login URL
        const loginUrl = upstoxAuthService.getLoginUrl();
        // logger.info("\n?? ACTION REQUIRED ??");
        // logger.info("Please open the following URL in your browser to login to Upstox:");
        logger.info("\n" + loginUrl + "\n");
        // logger.info("Waiting for callback...");
    });

    // 3. Handle Callback
    app.get("/callback", async (req, res) => {
        const code = req.query.code as string;

        if (code) {
            logger.info("\n? Authorization Code received!");
            res.send("<h1>Login Successful!</h1><p>You can close this window and check the terminal.</p>");

            try {
                // 4. Exchange Code for Token
                const token = await upstoxAuthService.generateAccessToken(code);
                // logger.info("\n? Access Token Generated Successfully!");
                logger.info("Token:", token.substring(0, 20) + "...");

                // In a real app, you might save this to DB/File. 
                // For now, the service caches it in memory, but since this script exits, 
                // the main app needs to do this or we need to persist it.
                // The service logic we wrote earlier just caches in memory.
                // The *Main App* needs the token.

                // logger.info("\n? NOTE: In a production setup, this token should be saved to a database or parsed from the daily login flow.");
                // logger.info("Since we are running this as a script, the token is valid for today.");

            } catch (error: any) {
                logger.error("? Failed to generate token:", error.message);
            } finally {
                server.close();
                process.exit(0);
            }
        } else {
            res.status(400).send("No code returned.");
            logger.error("No code returned in callback.");
            server.close();
            process.exit(1);
        }
    });
}

startAuth();
