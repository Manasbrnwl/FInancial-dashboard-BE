import express from "express";
import dotenv from "dotenv";
// import healthRouter from "./routes/health";
// import websocketRouter from "./routes/websocket";
import { loadEnv } from "./config/env";
import { initializeLoginJob } from "./jobs/loginJob";
import { initializeHourlyTicksNseFutJob } from "./jobs/hourlyTicksNseFutJob";
import { initializeDailyNseJob } from "./jobs/dailyNseOhlcJob";
// import { webSocketService } from "./services/websocketService";
// import { WebSocketManager } from "./utils/websocketManager";
import { initializeHourlyTicksNseOptJob } from "./jobs/hourlyTicksNseOptJob";

dotenv.config();
loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Routes
// app.use("/api/websocket", websocketRouter);

// Initialize the login job
initializeLoginJob();

// Initialize the hourly NSE futures job
initializeHourlyTicksNseFutJob();

// Initialize the hourly NSE options job
initializeHourlyTicksNseOptJob();

// Initialize the hourly NSE options job
initializeDailyNseJob();

// Initialize WebSocket service for real-time data
async function initializeWebSocketService() {
  try {
    // await webSocketService.start();

    // Subscribe to different symbol groups after connection is established
    setTimeout(() => {
      console.log("📡 Setting up symbol subscriptions...");

      // Subscribe to top NSE stocks
      // WebSocketManager.subscribeToNseTopSymbols();

      // Subscribe to NSE F&O symbols
      // WebSocketManager.subscribeToNseFOSymbols();

      console.log("✅ Symbol subscriptions configured");
    }, 3000); // Wait 3 seconds after connection
  } catch (error: any) {
    console.error("❌ Failed to initialize WebSocket service:", error.message);
  }
}

// Start WebSocket service
// initializeWebSocketService();

// Graceful shutdown handling
process.on("SIGTERM", () => {
  console.log("🛑 SIGTERM received, shutting down gracefully...");
  // WebSocketManager.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("🛑 SIGINT received, shutting down gracefully...");
  // WebSocketManager.stop();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
