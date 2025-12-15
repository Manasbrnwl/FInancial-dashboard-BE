import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import morgan from "morgan";
// import healthRouter from "./routes/health";
import websocketRouter from "./routes/websocket";
import { loadEnv } from "./config/env";
import { initializeLoginJob } from "./jobs/loginJob";
import { initializeHourlyTicksNseFutJob } from "./jobs/hourlyTicksNseFutJob";
import { initializeDailyNseJob } from "./jobs/dailyNseOhlcJob";
import { initializeBseEquityJob } from "./jobs/dailyBseEquityJob";
import { initializeDhanToken } from "./jobs/dhanTokenInitJob";
import { initializeWeeklyMarginCalculatorJob } from "./jobs/weeklyMarginCalculatorJob";
import { webSocketService } from "./services/websocketService";
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


initializeDhanToken().then(() => {
  initializeBseEquityJob();
  initializeWeeklyMarginCalculatorJob();
}).catch(err => console.error("Failed to initialize Dhan token:", err));

initializeLoginJob();

import { fetchAccessToken } from "./jobs/loginJob";

import { syncUpstoxIds } from "./jobs/upstoxSyncJob";

initializeHourlyTicksNseFutJob();

// (async () => {
// try {
// await fetchAccessToken();
// await syncUpstoxIds();
// await backfillGapsForDate('2025-12-08');
//   } catch (err) {
//     console.error("Initialization failed:", err);
//   }
// })();

initializeHourlyTicksNseOptJob();

initializeHourlyTicksNseEqJob();

initializeDailyNseJob();

initializeGapAverageLoader();
initializeGapHistoryCleanupJob();

import { initializeLoginReminderJob } from "./jobs/dailyLoginEmailJob";
initializeLoginReminderJob();



// Initialize WebSocket service for real-time data (arbitrage monitoring)
async function initializeWebSocketService() {
  try {
    await webSocketService.start();
  } catch (error: any) {
    console.error("❌ Failed to initialize WebSocket service:", error.message);
  }
}

// Start WebSocket service
initializeWebSocketService();

// Graceful shutdown handling
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  WebSocketManager.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully...");
  WebSocketManager.stop();
  process.exit(0);
});

httpServer.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
