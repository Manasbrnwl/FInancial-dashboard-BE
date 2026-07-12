import dotenv from "dotenv";
dotenv.config();

import prisma from "../config/prisma";

async function main() {
  console.log("Creating cron_job_status table...");
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS market_data.cron_job_status (
      job_name         VARCHAR(100) PRIMARY KEY,
      last_run         TIMESTAMPTZ,
      next_run         TIMESTAMPTZ,
      status           VARCHAR(20) NOT NULL DEFAULT 'idle',
      last_duration_ms INTEGER,
      error_message    TEXT,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
