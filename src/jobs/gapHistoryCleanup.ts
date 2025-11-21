import cron from "node-cron";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";

loadEnv();

const prisma = new PrismaClient();
const CRON_EXPRESSION = process.env.GAP_HISTORY_CLEANUP_CRON || "0 0 * * *"; // Midnight

function getRetentionDays(): number {
  const parsed = Number(process.env.GAP_HISTORY_RETENTION_DAYS || 20);
  return Number.isFinite(parsed) ? parsed : 20;
}

export function initializeGapHistoryCleanupJob(): void {
  cron.schedule(
    CRON_EXPRESSION,
    async () => {
      const retentionDays = getRetentionDays();
      try {
        await prisma.$executeRaw`
          DELETE FROM market_data.gap_time_series
          WHERE date < CURRENT_DATE - (${retentionDays} * INTERVAL '1 day')
        `;
        console.log(`?? Cleaned gap_time_series older than ${retentionDays} days`);
      } catch (error: any) {
        console.error("? Failed to cleanup gap_time_series:", error?.message || error);
      }
    },
    { timezone: "Asia/Kolkata" }
  );

  console.log(
    `?? Gap history cleanup scheduled with cron "${CRON_EXPRESSION}" (IST timezone)`
  );
}
