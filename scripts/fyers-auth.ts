/**
 * FYERS OAuth Helper — run this once per trading day to refresh your access_token.
 *
 * Steps:
 *   1. Run: npm run auth:fyers
 *   2. Open the printed URL in your browser and log in to FYERS
 *   3. After login, copy the full redirect URL from browser address bar
 *   4. Paste it here (or just the auth_code value) and press Enter
 *   5. Script exchanges auth_code → access_token and saves it to .env
 */

import dotenv from "dotenv";
import path from "path";
import * as readline from "readline";
import * as fs from "fs";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { fyersModel } = require("fyers-api-v3");

const ENV_PATH = path.resolve(__dirname, "../.env");

interface TokenResponse {
  s: string;
  access_token?: string;
  message?: string;
  code?: number;
}

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Extract auth_code from either a full redirect URL or a raw code string */
function extractAuthCode(input: string): string {
  try {
    const url = new URL(input);
    const code = url.searchParams.get("auth_code") ?? url.searchParams.get("code");
    if (code) return code;
  } catch {
    // Not a URL — treat as raw auth_code
  }
  return input;
}

/** Update or insert a key=value in the .env file */
function updateEnvFile(key: string, value: string): void {
  let content = fs.readFileSync(ENV_PATH, "utf-8");

  const pattern = new RegExp(`^${key}=.*$`, "m");
  if (pattern.test(content)) {
    content = content.replace(pattern, () => `${key}=${value}`);
  } else {
    content += `\n${key}=${value}`;
  }

  fs.writeFileSync(ENV_PATH, content, "utf-8");
}

async function main(): Promise<void> {
  const appId = process.env.FYERS_APP_ID;
  const appSecret = process.env.FYERS_APP_SECRET;
  const redirectUri = process.env.FYERS_REDIRECT_URI;

  if (!appId || !appSecret || !redirectUri) {
    console.error(
      "❌  Missing credentials in .env\n" +
        "    Required: FYERS_APP_ID, FYERS_APP_SECRET, FYERS_REDIRECT_URI"
    );
    process.exit(1);
  }

  // ── Step 1: Generate auth URL ──────────────────────────────────────────────
  const fyers = new fyersModel({ enableLogging: false });
  fyers.setAppId(appId);
  fyers.setRedirectUrl(redirectUri);

  const authUrl: string = fyers.generateAuthCode();

  console.log("\n🔐 FYERS OAuth — Daily Token Refresh");
  console.log("─".repeat(60));
  console.log("\n📋 Step 1: Open this URL in your browser and log in:\n");
  console.log(`   ${authUrl}\n`);
  console.log("─".repeat(60));
  console.log(
    "\n📋 Step 2: After login, copy the FULL redirect URL from the browser address bar."
  );
  console.log("   It will look like: https://your-redirect.com/?auth_code=eyJ...&state=...\n");

  // ── Step 2: Get auth_code from user ───────────────────────────────────────
  const input = await prompt("📥  Paste the redirect URL (or just the auth_code): ");

  if (!input) {
    console.error("❌  No input provided.");
    process.exit(1);
  }

  const authCode = extractAuthCode(input);
  console.log(`\n✅  auth_code extracted: ${authCode.substring(0, 20)}...`);

  // ── Step 3: Exchange auth_code for access_token ───────────────────────────
  console.log("\n⏳  Exchanging auth_code for access_token...");

  const response: TokenResponse = await fyers.generate_access_token({
    client_id: appId,
    secret_key: appSecret,
    auth_code: authCode,
  });

  if (response.s !== "ok" || !response.access_token) {
    console.error("❌  Token exchange failed:", response.message ?? JSON.stringify(response));
    process.exit(1);
  }

  const accessToken = response.access_token;

  // ── Step 4: Save to .env ──────────────────────────────────────────────────
  updateEnvFile("FYERS_ACCESS_TOKEN", accessToken);

  console.log("\n✅  access_token saved to .env");
  console.log(`   Token preview: ${accessToken.substring(0, 30)}...`);
  console.log("\n🚀  You can now run: npm run test:fyers\n");
}

main().catch((err: Error) => {
  console.error("❌  Unexpected error:", err.message);
  process.exit(1);
});
