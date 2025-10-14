import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
// import healthRouter from "./routes/health";
import websocketRouter from "./routes/websocket";
import { loadEnv } from "./config/env";
import { initializeLoginJob } from "./jobs/loginJob";
import { initializeHourlyTicksNseFutJob } from "./jobs/hourlyTicksNseFutJob";
import { initializeDailyNseJob } from "./jobs/dailyNseOhlcJob";
import { webSocketService } from "./services/websocketService";
import { WebSocketManager } from "./utils/websocketManager";
import { initializeHourlyTicksNseOptJob } from "./jobs/hourlyTicksNseOptJob";
import { initializeHourlyTicksNseEqJob } from "./jobs/hourlyTicksNseEqJob";
import apiRouter from "./routes/api";
import { socketIOService } from "./services/socketioService";

dotenv.config();
loadEnv();

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3000;

// Initialize Socket.io server for frontend connections
socketIOService.initialize(httpServer);
console.log("🔌 Socket.io server initialized for frontend connections");

// CORS configuration - allow requests from frontend
app.use(
  cors({
    origin: ["http://localhost:5173"],
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// Routes
app.use("/api", apiRouter);
app.use("/api/websocket", websocketRouter);

// Initialize the login job
initializeLoginJob();

// Initialize the hourly NSE futures job
initializeHourlyTicksNseFutJob();

// Initialize the hourly NSE options job
initializeHourlyTicksNseOptJob();

// Initialize the hourly NSE equity job
initializeHourlyTicksNseEqJob();

// Initialize the daily NSE options job
initializeDailyNseJob();

// Initialize WebSocket service for real-time data
async function initializeWebSocketService() {
  try {
    await webSocketService.start();

    // Subscribe to different symbol groups after connection is established
    setTimeout(() => {
      console.log("📡 Setting up symbol subscriptions...");

      // Subscribe to top NSE stocks
      WebSocketManager.subscribeToNseTopSymbols();

      // Subscribe to NSE F&O symbols
      WebSocketManager.subscribeToNseFOSymbols();

      console.log("✅ Symbol subscriptions configured");
    }, 3000); // Wait 3 seconds after connection
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
  console.log(
    `🔌 Socket.io ready for client connections on http://localhost:${PORT}`
  );
});
