import { spawn, ChildProcess } from "child_process";
import axios from "axios";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function runTests() {
  // 1. Get a valid instrument ID and symbol from the DB to test instrument-specific endpoints
  const instrument = await prisma.instrument_lists.findFirst({
    select: { id: true, instrument_type: true }
  });
  console.log("Test instrument selected from DB:", instrument);
  const instrumentId = instrument?.id || 1;
  const instrumentType = instrument?.instrument_type || "NIFTY";

  await prisma.$disconnect();

  // 2. Start the Express server
  console.log("Starting backend server...");
  const serverProc = spawn("npx", ["ts-node", "src/index.ts"], {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, PORT: "3099" }, // run on 3099 to avoid conflicts
  });

  // Wait 8 seconds for server startup
  await new Promise((resolve) => setTimeout(resolve, 8000));

  const client = axios.create({
    baseURL: "http://localhost:3099",
    validateStatus: () => true, // don't throw on error status codes
  });

  try {
    // 3. Login
    console.log("\n--- Logging in ---");
    const loginRes = await client.post("/api/auth/login-password", {
      username: "qa-local-test@example.com",
      password: "testpassword123",
    });
    console.log("Login Status:", loginRes.status);
    console.log("Login Response Data:", loginRes.data);

    if (!loginRes.data.success) {
      throw new Error("Login failed, cannot run other API tests");
    }

    const token = loginRes.data.token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    // 4. Test endpoints
    const endpoints = [
      { url: "/api/health", method: "GET" },
      { url: `/api/nse-equity?symbol=${instrumentType}`, method: "GET" },
      { url: `/api/bse-equity?symbol=500325`, method: "GET" },
      { url: `/api/nse-futures?underlying=${instrumentId}`, method: "GET" },
      { url: `/api/nse-options?underlying=${instrumentId}`, method: "GET" },
      { url: `/api/periodic-data/ohlc/nse?underlying=${instrumentType}`, method: "GET" },
      { url: `/api/arbitrage?instrumentId=${instrumentId}`, method: "GET" },
      { url: `/api/arbitrage-details/${instrumentId}`, method: "GET" },
      { url: `/api/cron-status`, method: "GET" },
      { url: `/api/gap-alerts`, method: "GET" },
      { url: `/api/live-data/equities`, method: "GET" },
      { url: `/api/live-data/equities/${instrumentId}/symbols`, method: "GET" },
      { url: `/api/margin-calculator/stored`, method: "GET" },
      { url: `/api/covered-calls`, method: "GET" },
      { url: `/api/covered-calls/stats`, method: "GET" },
      { url: `/api/covered-calls/by-underlying?underlying=${instrumentType}`, method: "GET" },
      { url: `/api/covered-calls/${instrumentId}/symbols-expiry`, method: "GET" },
      { url: `/api/covered-calls/${instrumentId}/filtered`, method: "GET" },
      { url: `/api/covered-calls/${instrumentId}/latest`, method: "GET" },
      { url: `/api/covered-calls/${instrumentId}/trend/daily`, method: "GET" },
      { url: `/api/covered-calls/${instrumentId}/trend/hourly`, method: "GET" },
    ];

    console.log("\n--- Testing Endpoints ---");
    for (const ep of endpoints) {
      console.log(`\nTesting ${ep.method} ${ep.url}...`);
      const res = await client.request({
        url: ep.url,
        method: ep.method as any,
        headers: authHeaders,
      });
      console.log("Status:", res.status);
      console.log("Response Success:", res.data?.success);
      if (res.data?.success) {
        console.log("Keys in response data:", Object.keys(res.data));
        if (Array.isArray(res.data.data)) {
          console.log(`Returned ${res.data.data.length} records`);
        }
      } else {
        console.log("Error Message:", res.data?.error || res.data?.message || res.data);
      }
    }
  } catch (err: any) {
    console.error("Test execution failed:", err.message);
  } finally {
    console.log("\nKilling backend server...");
    serverProc.kill("SIGINT");
    process.exit(0);
  }
}

runTests();
