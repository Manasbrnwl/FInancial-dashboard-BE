import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import morgan from "morgan";
import cron from "node-cron";
import { devLog, devError, prodError } from "./utils/errorLogger";
import { globalErrorHandler } from "./middleware/errorHandler";
import websocketRouter from "./routes/websocket";
import { loadEnv } from "./config/env";
import { upstoxWebSocketService } from "./services/upstoxWebsocketService";
import { WebSocketManager } from "./utils/websocketManager";
import { initializeHourlyTicksNseOptJob } from "./jobs/hourlyTicksNseOptJob";
import { initializeGapAverageLoader } from "./jobs/gapAverageLoader";
import { initializeGapHistoryCleanupJob } from "./jobs/gapHistoryCleanup";
import apiRouter from "./routes/api";
import { socketIOService } from "./services/socketioService";
import authRouter from "./routes/auth";
import { authenticateRequest } from "./middleware/authMiddleware";
import { mcpAuthRouter } from "./mcp/sdk";
import { oauthProvider, loginHandler, loginRateLimiter } from "./mcp/oauthProvider";
import mcpRouter from "./mcp/mcpRouter";
import { renderAuthPage, renderTokenResult } from "./mcp/authPages";
import { findUserByEmail, verifyPassword } from "./services/authService";

import { initializeHourlyTicksNseEqUpstoxJob } from "./jobs/hourlyTicksNseEqUpstoxJob";
import { initializeHourlyTicksNseFutUpstoxJob } from "./jobs/hourlyTicksNseFutUpstoxJob";
import { initializeDailyOhlcUpstoxJob } from "./jobs/dailyOhlcUpstoxJob";
import { initializeCoveredCallAlertJob } from "./jobs/coveredCallAlertJob";
import { syncHistoricalSymbols } from "./scripts/fetchHistoricalSymbols";
import { initializeLoginReminderJob } from "./jobs/dailyLoginEmailJob";
import { preloadInstrumentCache } from "./cache/instrumentCache";

// Polyfill for BigInt JSON serialization
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

dotenv.config();
loadEnv();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize Socket.io server for frontend connections
socketIOService.initialize(httpServer);

// CORS configuration - allow requests from frontend
app.use(
  cors({
    origin: [
      "https://anfy.in",
      "https://www.anfy.in",
      "anfy.in",
      "www.anfy.in",
      "http://localhost:5173",
      "http://localhost:5174",
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "dev" : "combined"));
// Routes
app.use("/api/auth", authRouter);
app.use("/api/websocket", authenticateRequest, websocketRouter);
app.use("/api", apiRouter);

// ---------------------------------------------------------------------------
// MCP server — same port as the main API. Exposes read-only market data
// tools to AI clients (Claude, Cursor, etc.) via OAuth 2.1 (PKCE) or a
// manually-generated Bearer token from GET /auth.
// ---------------------------------------------------------------------------
const mcpBaseUrl = new URL(process.env.MCP_BASE_URL ?? `http://localhost:${PORT}`);

app.use(
  mcpAuthRouter({
    provider: oauthProvider,
    issuerUrl: mcpBaseUrl,
    baseUrl: mcpBaseUrl,
    resourceServerUrl: new URL("/mcp", mcpBaseUrl),
    resourceName: "Finance Dashboard MCP",
    scopesSupported: ["read"],
  })
);
app.post("/oauth/login", loginRateLimiter, loginHandler);
app.use("/mcp", mcpRouter);

const MCP_AUTH_CSP = "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'";

app.get("/auth", (_req, res) => {
  res.setHeader("Content-Security-Policy", MCP_AUTH_CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.send(renderAuthPage());
});

app.post("/auth", loginRateLimiter, async (req, res) => {
  res.setHeader("Content-Security-Policy", MCP_AUTH_CSP);
  res.setHeader("X-Frame-Options", "DENY");

  const { email, password } = req.body as Record<string, string>;
  if (!email || !password) {
    return res.status(400).send(renderAuthPage("Email and password are required."));
  }

  const user = await findUserByEmail(email).catch(() => null);
  if (!user || !user.password || !user.isActive) {
    return res.status(401).send(renderAuthPage("Invalid email or password."));
  }

  const isValid = await verifyPassword(password, user.password).catch(() => false);
  if (!isValid) {
    return res.status(401).send(renderAuthPage("Invalid email or password."));
  }

  const { accessToken, expiresAt } = oauthProvider.mintAccessToken(String(user.id), user.email);
  const expiryDate = new Date(expiresAt * 1000).toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
  });

  return res.send(renderTokenResult(accessToken, user.email, expiryDate, new URL("/mcp", mcpBaseUrl).toString()));
});

// Temporary Upstox Callback Route
import { upstoxAuthService } from "./services/upstoxAuthService";


app.get("/callback", async (req, res) => {
  const code = req.query.code as string;
  if (code) {
    try {
      const token = await upstoxAuthService.generateAccessToken(code);
      devLog("? Upstox Token Generated:", token.substring(0, 10) + "...");
      res.send(`<h1>Login Successful</h1><p>Token generated. check console.</p>`);
    } catch (err: any) {
      res.status(500).send("Error: " + err.message);
    }
  } else {
    res.status(400).send("No code");
  }
});

// Weekly Instrument Sync (NSE Bhavcopy) - Runs every Tuesday at 6 AM IST
async function syncNewSymbolsFromBhavcopy() {
  // devLog("📊 Starting weekly Bhavcopy instrument sync...");
  try {
    const eightDaysAgo = new Date();
    eightDaysAgo.setDate(eightDaysAgo.getDate() - 8);
    const from = eightDaysAgo.toISOString().split("T")[0];
    const to = new Date().toISOString().split("T")[0];
    await syncHistoricalSymbols(from, to);
    // devLog("✅ Weekly Bhavcopy instrument sync completed");
  } catch (error: any) {
    devError("❌ Failed to sync instruments from Bhavcopy:", error.message);
    prodError("Failed to sync instruments from Bhavcopy");
  }
}

// Schedule to run every Tuesday at 6 AM (cron: 0 6 * * 2)
cron.schedule("0 6 * * 2", syncNewSymbolsFromBhavcopy, {
  timezone: "Asia/Kolkata",
});
devLog("📅 Weekly Bhavcopy Instrument Sync scheduled (Every Tuesday 6 AM IST)");

// Run immediately on startup in development mode
if (process.env.NODE_ENV === "development") {
  syncNewSymbolsFromBhavcopy();
}

// Preload instrument metadata cache for faster lookups
preloadInstrumentCache();

initializeHourlyTicksNseOptJob();

initializeHourlyTicksNseEqUpstoxJob();
initializeHourlyTicksNseFutUpstoxJob();

initializeDailyOhlcUpstoxJob(); // New: Daily OHLC using Upstox V3 API (replaces TrueData Bhavcopy)

// Initialize Covered Call Alert Job (5-minute check for alert criteria)
initializeCoveredCallAlertJob();

initializeGapAverageLoader();
initializeGapHistoryCleanupJob();

initializeLoginReminderJob();

// Initialize Upstox WebSocket service for real-time data (arbitrage monitoring)
async function initializeWebSocketService() {
  try {
    await upstoxWebSocketService.start();
  } catch (error: any) {
    devError("❌ Failed to initialize Upstox WebSocket service:", error.message);
    prodError("Failed to initialize Upstox WebSocket service");
  }
}

// Start WebSocket service
initializeWebSocketService();

// Graceful shutdown handling
process.on("SIGTERM", () => {
  WebSocketManager.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  WebSocketManager.stop();
  process.exit(0);
});

// Register global error handler (must be after all routes)
app.use(globalErrorHandler);

httpServer.listen(PORT, () => {
  devLog(`🚀 Server running on http://localhost:${PORT}`);
});
