import express from "express";
import dotenv from "dotenv";
// import healthRouter from "./routes/health";
import { loadEnv } from "./config/env";
import { initializeLoginJob } from "./jobs/loginJob";
import { initializeClusters } from "./cluster";

dotenv.config();
loadEnv();

// Function to run in the primary process
function primaryProcess() {
  console.log('📊 Primary process is handling cluster management');
  
  // Initialize the login job only in the primary process
  initializeLoginJob();
}

// Function to run in each worker process
function workerProcess() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json());

  // Routes
  // app.use("/health", healthRouter);

  app.listen(PORT, () => {
    console.log(`🚀 Worker ${process.pid} running on http://localhost:${PORT}`);
  });
}

// Initialize clusters to utilize all CPU cores
initializeClusters(primaryProcess, workerProcess);
