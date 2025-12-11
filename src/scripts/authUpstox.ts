import express from "express";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { loadEnv } from "../config/env";

loadEnv();

const app = express();
const PORT = 3000;

async function startAuth() {
    // 1. Start Server
    const server = app.listen(PORT, () => {
        console.log(`\n?? Auth Server running on http://localhost:${PORT}`);

        // 2. Generate and Print Login URL
        const loginUrl = upstoxAuthService.getLoginUrl();
        // console.log("\n?? ACTION REQUIRED ??");
        // console.log("Please open the following URL in your browser to login to Upstox:");
        console.log("\n" + loginUrl + "\n");
        // console.log("Waiting for callback...");
    });

    // 3. Handle Callback
    app.get("/callback", async (req, res) => {
        const code = req.query.code as string;

        if (code) {
            console.log("\n? Authorization Code received!");
            res.send("<h1>Login Successful!</h1><p>You can close this window and check the terminal.</p>");

            try {
                // 4. Exchange Code for Token
                const token = await upstoxAuthService.generateAccessToken(code);
                // console.log("\n? Access Token Generated Successfully!");
                console.log("Token:", token.substring(0, 20) + "...");

                // In a real app, you might save this to DB/File. 
                // For now, the service caches it in memory, but since this script exits, 
                // the main app needs to do this or we need to persist it.
                // The service logic we wrote earlier just caches in memory.
                // The *Main App* needs the token.

                // console.log("\n? NOTE: In a production setup, this token should be saved to a database or parsed from the daily login flow.");
                // console.log("Since we are running this as a script, the token is valid for today.");

            } catch (error: any) {
                console.error("? Failed to generate token:", error.message);
            } finally {
                server.close();
                process.exit(0);
            }
        } else {
            res.status(400).send("No code returned.");
            console.error("No code returned in callback.");
            server.close();
            process.exit(1);
        }
    });
}

startAuth();
