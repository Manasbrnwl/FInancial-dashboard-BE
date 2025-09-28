import express from "express";
import dotenv from "dotenv";
// import healthRouter from "./routes/health";
import { loadEnv } from "./config/env";
import { initializeLoginJob } from "./jobs/loginJob";
import { initializeHourlyNseOptionsJob } from "./jobs/hourlyNseOptionsJob";
import { initializeDailyNseEquitysJob } from "./jobs/dailyNseEquityJob";

dotenv.config();
loadEnv();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Routes
// app.use("/health", healthRouter);

// Initialize the login job
initializeLoginJob();

// Initialize the hourly NSE options job
initializeHourlyNseOptionsJob();

// Initialize the hourly NSE options job
initializeDailyNseEquitysJob();

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
