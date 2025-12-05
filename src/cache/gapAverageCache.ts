import { Prisma, PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";

loadEnv();

interface GapBaseline {
  baselineGap1: number | null;
  baselineGap2: number | null;
  baselineDate: Date | null; // most recent sample date in the window
}

// Map<instrumentId, GapBaseline> 
const gapBaselines = new Map<number, GapBaseline>();
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
 * Load the freshest baseline per instrument.
 * Computes average gaps from the most recent 5 data points per instrument.
 */
export async function loadGapBaselines(): Promise<void> {
  const { minDays, maxDays } = getBaselineWindow();

  const rows = await prisma.$queryRaw<Array<{
    instrument_id: number;
    baseline_gap_1: number | null;
    baseline_gap_2: number | null;
    baseline_date: Date | null;
  }>>(Prisma.sql`
    with ranked_gap_series as (
	    select *,
		    row_number() over (partition by instrument_id order by date desc, time_slot desc, id desc) rn
	    from market_data.gap_time_series)
    SELECT
      instrument_id,
      AVG(gap_1) AS baseline_gap_1,
      AVG(gap_2) AS baseline_gap_2,
      MAX(date) AS baseline_date
    FROM ranked_gap_series
    WHERE rn <= 5
    GROUP BY instrument_id
  `);

  gapBaselines.clear();

  rows.forEach((row) => {
    gapBaselines.set(row.instrument_id, {
      baselineGap1: row.baseline_gap_1,
      baselineGap2: row.baseline_gap_2,
      baselineDate: row.baseline_date,
    });
  });

  console.log(
    `?? Loaded gap baselines for ${gapBaselines.size} instruments`
  );
}

export function getGapBaseline(
  instrumentId: number
): GapBaseline | undefined {
  return gapBaselines.get(instrumentId);
}

export function clearGapBaselines(): void {
  gapBaselines.clear();
}
