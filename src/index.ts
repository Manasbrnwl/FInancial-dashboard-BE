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

import { initializeHourlyTicksNseEqUpstoxJob } from "./jobs/hourlyTicksNseEqUpstoxJob";
import { initializeHourlyTicksNseFutUpstoxJob } from "./jobs/hourlyTicksNseFutUpstoxJob";
import { initializeDailyOhlcUpstoxJob } from "./jobs/dailyOhlcUpstoxJob";
import { initializeCoveredCallAlertJob } from "./jobs/coveredCallAlertJob";
import { upstoxInstrumentService } from "./services/upstoxInstrumentService";
import { initializeLoginReminderJob } from "./jobs/dailyLoginEmailJob";
import { preloadInstrumentCache } from "./cache/instrumentCache";

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
    ],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(morgan(process.env.NODE_ENV === "production" ? "dev" : "combined"));
// Routes
app.use("/api/auth", authRouter);
app.use("/api/websocket", authenticateRequest, websocketRouter);
app.use("/api", apiRouter);

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

// Weekly Upstox Instrument Sync - Runs every Tuesday at 6 AM IST
async function syncUpstoxInstruments() {
  // devLog("📊 Starting weekly Upstox instrument sync...");
  try {
    await upstoxInstrumentService.loadNseEqInstruments();
    await upstoxInstrumentService.loadNseFutInstruments();
    await upstoxInstrumentService.loadNseOptInstruments();
    // devLog("✅ Weekly Upstox instrument sync completed");
  } catch (error: any) {
    devError("❌ Failed to sync Upstox instruments:", error.message);
    prodError("Failed to sync Upstox instruments");
  }
}

// Schedule to run every Tuesday at 6 AM (cron: 0 6 * * 2)
cron.schedule("0 6 * * 2", syncUpstoxInstruments, {
  timezone: "Asia/Kolkata",
});
devLog("📅 Weekly Upstox Instrument Sync scheduled (Every Tuesday 6 AM IST)");

// Run immediately on startup in development mode
if (process.env.NODE_ENV === "development") {
  syncUpstoxInstruments();
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
