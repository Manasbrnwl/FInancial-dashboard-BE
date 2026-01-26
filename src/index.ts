import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import morgan from "morgan";
import cron from "node-cron";
// import healthRouter from "./routes/health";
import websocketRouter from "./routes/websocket";
import { loadEnv } from "./config/env";
import { initializeLoginJob } from "./jobs/loginJob";
import { initializeHourlyTicksNseFutJob } from "./jobs/hourlyTicksNseFutJob";
import { initializeDailyNseJob } from "./jobs/dailyNseOhlcJob";
import { initializeBseEquityJob } from "./jobs/dailyBseEquityJob";
import { initializeDhanToken } from "./jobs/dhanTokenInitJob";
import { initializeWeeklyMarginCalculatorJob } from "./jobs/weeklyMarginCalculatorJob";
import { upstoxWebSocketService } from "./services/upstoxWebsocketService";
import { WebSocketManager } from "./utils/websocketManager";
import { initializeHourlyTicksNseOptJob } from "./jobs/hourlyTicksNseOptJob";
import { initializeHourlyTicksNseEqJob } from "./jobs/hourlyTicksNseEqJob";
import { initializeGapAverageLoader } from "./jobs/gapAverageLoader";
import { initializeGapHistoryCleanupJob } from "./jobs/gapHistoryCleanup";
import apiRouter from "./routes/api";
import { socketIOService } from "./services/socketioService";
import authRouter from "./routes/auth";
import { authenticateRequest } from "./middleware/authMiddleware";
import { backfillGapsForDate } from "./services/manualBackfillService";

import { initializeHourlyTicksNseEqUpstoxJob } from "./jobs/hourlyTicksNseEqUpstoxJob";
import { initializeHourlyTicksNseFutUpstoxJob } from "./jobs/hourlyTicksNseFutUpstoxJob";
import { initializeDailyOhlcUpstoxJob } from "./jobs/dailyOhlcUpstoxJob";
import { upstoxInstrumentService } from "./services/upstoxInstrumentService";
import { initializeLoginReminderJob } from "./jobs/dailyLoginEmailJob";
import { fetchAccessToken } from "./jobs/loginJob";

dotenv.config();
loadEnv();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize Socket.io server for frontend connections
socketIOService.initialize(httpServer);
// console.log("🔌 Socket.io server initialized for frontend connections");

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
app.use(morgan("dev"));
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
      console.log("? Upstox Token Generated:", token.substring(0, 10) + "...");
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
  console.log("📊 Starting weekly Upstox instrument sync...");
  try {
    await upstoxInstrumentService.loadNseEqInstruments();
    await upstoxInstrumentService.loadNseFutInstruments();
    await upstoxInstrumentService.loadNseOptInstruments();
    console.log("✅ Weekly Upstox instrument sync completed");
  } catch (error: any) {
    console.error("❌ Failed to sync Upstox instruments:", error.message);
  }
}

// Schedule to run every Tuesday at 6 AM (cron: 0 6 * * 2)
cron.schedule("0 6 * * 2", syncUpstoxInstruments, {
  timezone: "Asia/Kolkata",
});
console.log("📅 Weekly Upstox Instrument Sync scheduled (Every Tuesday 6 AM IST)");

// Run immediately on startup in development mode
if (process.env.NODE_ENV === "development") {
  syncUpstoxInstruments();
}


// initializeDhanToken().then(() => {
//   initializeBseEquityJob();
//   initializeWeeklyMarginCalculatorJob();
// }).catch(err => console.error("Failed to initialize Dhan token:", err));

// initializeLoginJob();

// initializeHourlyTicksNseFutJob();

// (async () => {
// try {
// await backfillGapsForDate('2025-12-08');
//   } catch (err) {
//     console.error("Initialization failed:", err);
//   }
// }
// )();

initializeHourlyTicksNseOptJob();

initializeHourlyTicksNseEqUpstoxJob();
initializeHourlyTicksNseFutUpstoxJob();

initializeDailyOhlcUpstoxJob(); // New: Daily OHLC using Upstox V3 API (replaces TrueData Bhavcopy)

initializeGapAverageLoader();
initializeGapHistoryCleanupJob();

initializeLoginReminderJob();



// Initialize Upstox WebSocket service for real-time data (arbitrage monitoring)
async function initializeWebSocketService() {
  try {
    await upstoxWebSocketService.start();
  } catch (error: any) {
    console.error("❌ Failed to initialize Upstox WebSocket service:", error.message);
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

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
