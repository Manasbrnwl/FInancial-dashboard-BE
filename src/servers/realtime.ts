import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "http";
import { devLog, devError, prodError } from "../utils/errorLogger";
import { loadEnv } from "../config/env";
import { socketIOService } from "../services/socketioService";
import { upstoxWebSocketService } from "../services/upstoxWebsocketService";
import { WebSocketManager } from "../utils/websocketManager";
import websocketRouter from "../routes/websocket";
import { authenticateRequest } from "../middleware/authMiddleware";
import { globalErrorHandler } from "../middleware/errorHandler";

// Polyfill for BigInt JSON serialization
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * The realtime process — Socket.io server for frontend clients plus the
 * Upstox WebSocket ingestion that feeds it. Isolated from the API and cron
 * jobs so live-tick fan-out and reconnect handling never queue behind a slow
 * DB query or a 5-minute cron burst on the same event loop.
 */
export function startRealtimeServer(): void {
  dotenv.config();
  loadEnv();

  const app = express();
  const httpServer = createServer(app);
  const PORT = process.env.REALTIME_PORT || 3001;

  // Initialize Socket.io server for frontend connections
  socketIOService.initialize(httpServer);

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

  app.use("/api/websocket", authenticateRequest, websocketRouter);

  app.get("/health", (_req, res) => {
    res.json({
      success: true,
      message: "Realtime service is running",
      upstoxWebSocket: upstoxWebSocketService.getStatus(),
      timestamp: new Date().toISOString(),
    });
  });

  app.use(globalErrorHandler);

  // Start Upstox WebSocket ingestion (only connects during market hours; self-schedules
  // reconnection for the next market open when outside hours)
  (async function initializeWebSocketService() {
    try {
      await upstoxWebSocketService.start();
    } catch (error: any) {
      devError("Failed to initialize Upstox WebSocket service:", error.message);
      prodError("Failed to initialize Upstox WebSocket service");
    }
  })();

  process.on("SIGTERM", () => {
    WebSocketManager.stop();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    WebSocketManager.stop();
    process.exit(0);
  });

  httpServer.listen(PORT, () => {
    devLog(`Realtime server running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startRealtimeServer();
}
