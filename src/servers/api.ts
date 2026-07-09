import express from "express";
import cors from "cors";
import compression from "compression";
import dotenv from "dotenv";
import morgan from "morgan";
import { devLog } from "../utils/errorLogger";
import { globalErrorHandler } from "../middleware/errorHandler";
import { loadEnv } from "../config/env";
import apiRouter from "../routes/api";
import authRouter from "../routes/auth";
import { oauthProvider, loginHandler, loginRateLimiter } from "../mcp/oauthProvider";
import { mcpAuthRouter } from "../mcp/sdk";
import mcpRouter from "../mcp/mcpRouter";
import { renderAuthPage, renderTokenResult } from "../mcp/authPages";
import { findUserByEmail, verifyPassword } from "../services/authService";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { fyersAuthService } from "../services/fyersAuthService";

// Polyfill for BigInt JSON serialization
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

/**
 * The REST API process — no Socket.io, no Upstox WebSocket ingestion, no cron
 * jobs. Those live in the realtime and sync-worker processes respectively, so
 * a burst of 5-minute cron activity or live-tick fan-out never competes with
 * API request handling on the same event loop.
 */
export function startApiServer(): void {
  dotenv.config();
  loadEnv();

  const app = express();
  const PORT = process.env.API_PORT || process.env.PORT || 3000;

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

  app.use(compression());
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

  // Routes
  app.use("/api/auth", authRouter);
  app.use("/api", apiRouter);

  // ---------------------------------------------------------------------------
  // MCP server — same process/port as the main API. Exposes read-only market
  // data tools to AI clients (Claude, Cursor, etc.) via OAuth 2.1 (PKCE) or a
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

  // Upstox OAuth callback — completes the manual re-auth flow (see upstoxAuthService.getLoginUrl())
  app.get("/callback", async (req, res) => {
    const code = req.query.code as string;
    if (code) {
      try {
        const token = await upstoxAuthService.generateAccessToken(code);
        devLog("Upstox Token Generated:", token.substring(0, 10) + "...");
        res.send(`<h1>Login Successful</h1><p>Token generated. check console.</p>`);
      } catch (err: any) {
        res.status(500).send("Error: " + err.message);
      }
    } else {
      res.status(400).send("No code");
    }
  });

  // Fyers OAuth callback — registered as the redirect URI on the Fyers app,
  // same pattern as the Upstox /callback above.
  app.get("/fyers", async (req, res) => {
    const code = (req.query.auth_code as string) || (req.query.code as string);
    if (code) {
      try {
        const token = await fyersAuthService.generateAccessToken(code);
        devLog("Fyers Token Generated:", token.substring(0, 10) + "...");
        res.send(`<h1>Login Successful</h1><p>Token generated. check console.</p>`);
      } catch (err: any) {
        res.status(500).send("Error: " + err.message);
      }
    } else {
      res.status(400).send("No auth_code");
    }
  });

  // Register global error handler (must be after all routes)
  app.use(globalErrorHandler);

  app.listen(PORT, () => {
    devLog(`API server running on http://localhost:${PORT}`);
  });
}

if (require.main === module) {
  startApiServer();
}
