import { Prisma, PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";

loadEnv();

interface GapBaseline {
  baselineGap1: number | null;
  baselineGap2: number | null;
  baselineDate: Date | null; // most recent sample date in the window
}

// Map<instrumentId, Map<timeSlot, GapBaseline>>
const gapBaselines = new Map<number, Map<string, GapBaseline>>();
const prisma = new PrismaClient();

function getBaselineWindow(): { minDays: number; maxDays: number } {
  const minDays = Number(process.env.GAP_BASELINE_DAYS_MIN || 10);
  const maxDays = Number(process.env.GAP_BASELINE_DAYS_MAX || 20);

  const resolvedMin = Number.isFinite(minDays) ? minDays : 10;
  const resolvedMax = Number.isFinite(maxDays) ? maxDays : 20;
  const [lower, upper] = [resolvedMin, resolvedMax].sort((a, b) => a - b);

  return { minDays: lower, maxDays: upper };
}

/**
 * Load the freshest baseline per instrument/time-slot within the configured 10–20 day window.
 */
export async function loadGapBaselines(): Promise<void> {
  const { minDays, maxDays } = getBaselineWindow();

  const rows = await prisma.$queryRaw<Array<{
    instrument_id: number;
    time_slot: string;
    baseline_gap_1: number | null;
    baseline_gap_2: number | null;
    baseline_date: Date | null;
  }>>(Prisma.sql`
    SELECT
      instrument_id,
      time_slot,
      AVG(gap_1) AS baseline_gap_1,
      AVG(gap_2) AS baseline_gap_2,
      MAX(date) AS baseline_date
    FROM market_data.gap_time_series
    WHERE date BETWEEN CURRENT_DATE - (20 * INTERVAL '1 day')
                AND CURRENT_DATE - (0 * INTERVAL '1 day')
    GROUP BY instrument_id, time_slot
  `);

  gapBaselines.clear();

  rows.forEach((row) => {
    if (!gapBaselines.has(row.instrument_id)) {
      gapBaselines.set(row.instrument_id, new Map());
    }

    gapBaselines.get(row.instrument_id)!.set(row.time_slot, {
      baselineGap1: row.baseline_gap_1,
      baselineGap2: row.baseline_gap_2,
      baselineDate: row.baseline_date,
    });
  });

  console.log(
    `?? Loaded gap baselines for ${gapBaselines.size} instruments (window ${maxDays}-${minDays} days)`
  );
}

export function getGapBaseline(
  instrumentId: number,
  timeSlot: string
): GapBaseline | undefined {
  return gapBaselines.get(instrumentId)?.get(timeSlot);
}

export function clearGapBaselines(): void {
  gapBaselines.clear();
}
