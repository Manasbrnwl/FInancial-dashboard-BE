import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";

loadEnv();
const prisma = new PrismaClient();

interface MissingEquity {
  id: number;
  name: string;
  upstox_id: string;
  last_date: Date | null;
  missing_from: string;
  missing_to: string;
}

interface MissingFutOpt {
  symbol_id: number;
  instrument_id: number;
  symbol: string;
  segment: string;
  expiry_date: Date | null;
  upstox_id: string;
  last_date: Date | null;
  missing_from: string;
  missing_to: string;
}

function fmt(d: Date | null | string): string {
  if (!d) return "N/A";
  return new Date(d).toISOString().split("T")[0];
}

async function findMissingEquity(): Promise<void> {
  console.log("\n==================================================");
  console.log("  NSE EQUITY — Missing / Stale Historical Data");
  console.log("==================================================");

  // Get the most recent date we have for ANY equity instrument
  const maxRow = await prisma.$queryRaw<Array<{ max_date: Date | null }>>`
    SELECT MAX(date) AS max_date FROM market_data.nse_equity
  `;
  const maxDate = maxRow[0]?.max_date;

  if (!maxDate) {
    console.log("  No equity data found in nse_equity at all.");
    return;
  }

  console.log(`  Latest date in nse_equity: ${fmt(maxDate)}\n`);

  // Per-instrument last date — use symbol_id (int FK) to avoid casting legacy symbol strings
  const rows = await prisma.$queryRaw<MissingEquity[]>`
    WITH per_instrument AS (
      SELECT symbol_id AS instrument_id, MAX(date) AS last_date
      FROM market_data.nse_equity
      WHERE symbol_id IS NOT NULL
      GROUP BY symbol_id
    )
    SELECT
      il.id,
      il.instrument_type          AS name,
      il.upstox_id,
      pi.last_date,
      CASE
        WHEN pi.last_date IS NULL THEN '2024-01-01'
        ELSE to_char(pi.last_date + INTERVAL '1 day', 'YYYY-MM-DD')
      END AS missing_from,
      to_char(${maxDate}::date, 'YYYY-MM-DD') AS missing_to
    FROM market_data.instrument_lists il
    LEFT JOIN per_instrument pi ON pi.instrument_id = il.id
    WHERE
      il.upstox_id IS NOT NULL
      AND (il.upstox_id LIKE 'NSE_EQ%' OR il.upstox_id LIKE 'NSE_INDEX%')
      AND (pi.last_date IS NULL OR pi.last_date < ${maxDate}::date)
    ORDER BY pi.last_date ASC NULLS FIRST, il.instrument_type
  `;

  if (rows.length === 0) {
    console.log("  ✅ All equity instruments are up to date.");
    return;
  }

  const neverSynced = rows.filter((r) => r.last_date === null);
  const stale = rows.filter((r) => r.last_date !== null);

  if (neverSynced.length > 0) {
    console.log(`  ❌ Never synced (${neverSynced.length} instruments):`);
    console.log(
      `  ${"Name".padEnd(40)} ${"Upstox ID".padEnd(30)} ${"Missing From".padEnd(14)} Missing To`
    );
    console.log("  " + "-".repeat(100));
    for (const r of neverSynced) {
      console.log(
        `  ${r.name.padEnd(40)} ${r.upstox_id.padEnd(30)} ${String(r.missing_from).padEnd(14)} ${r.missing_to}`
      );
    }
  }

  if (stale.length > 0) {
    console.log(`\n  ⚠️  Stale / partial data (${stale.length} instruments):`);
    console.log(
      `  ${"Name".padEnd(40)} ${"Upstox ID".padEnd(30)} ${"Last Date".padEnd(12)} ${"Missing From".padEnd(14)} Missing To`
    );
    console.log("  " + "-".repeat(112));
    for (const r of stale) {
      console.log(
        `  ${r.name.padEnd(40)} ${r.upstox_id.padEnd(30)} ${fmt(r.last_date).padEnd(12)} ${String(r.missing_from).padEnd(14)} ${r.missing_to}`
      );
    }
  }

  console.log(`\n  Total missing/stale: ${rows.length} instruments`);
}

async function findMissingFutures(): Promise<void> {
  console.log("\n==================================================");
  console.log("  NSE FUTURES — Missing / Stale Historical Data");
  console.log("==================================================");

  const maxRow = await prisma.$queryRaw<Array<{ max_date: Date | null }>>`
    SELECT MAX(date) AS max_date FROM market_data.nse_futures
  `;
  const maxDate = maxRow[0]?.max_date;

  if (!maxDate) {
    console.log("  No futures data found in nse_futures at all.");
    return;
  }

  console.log(`  Latest date in nse_futures: ${fmt(maxDate)}\n`);

  // For futures, check which symbols have no data or data before max date
  const rows = await prisma.$queryRaw<MissingFutOpt[]>`
    WITH per_symbol AS (
      SELECT symbol AS symbol_id, MAX(date) AS last_date
      FROM market_data.nse_futures
      GROUP BY symbol
    )
    SELECT
      sl.id                              AS symbol_id,
      sl.instrument_id,
      sl.symbol,
      sl.segment,
      sl.expiry_date,
      sl.upstox_id,
      ps.last_date,
      CASE
        WHEN ps.last_date IS NULL THEN '2025-09-01'
        ELSE to_char(ps.last_date + INTERVAL '1 day', 'YYYY-MM-DD')
      END AS missing_from,
      to_char(${maxDate}::date, 'YYYY-MM-DD') AS missing_to
    FROM market_data.symbols_list sl
    LEFT JOIN per_symbol ps ON ps.symbol_id = sl.id
    WHERE
      sl.upstox_id IS NOT NULL
      AND sl.segment = 'FUT'
      AND sl.expiry_date >= CURRENT_DATE
      AND (ps.last_date IS NULL OR ps.last_date < ${maxDate}::date)
    ORDER BY ps.last_date ASC NULLS FIRST, sl.symbol
  `;

  if (rows.length === 0) {
    console.log("  ✅ All active futures contracts are up to date.");
    return;
  }

  const neverSynced = rows.filter((r) => r.last_date === null);
  const stale = rows.filter((r) => r.last_date !== null);

  if (neverSynced.length > 0) {
    console.log(`  ❌ Never synced (${neverSynced.length} contracts):`);
    console.log(
      `  ${"Symbol".padEnd(50)} ${"Expiry".padEnd(12)} ${"Missing From".padEnd(14)} Missing To`
    );
    console.log("  " + "-".repeat(100));
    for (const r of neverSynced) {
      console.log(
        `  ${r.symbol.padEnd(50)} ${fmt(r.expiry_date).padEnd(12)} ${String(r.missing_from).padEnd(14)} ${r.missing_to}`
      );
    }
  }

  if (stale.length > 0) {
    console.log(`\n  ⚠️  Stale / partial data (${stale.length} contracts):`);
    console.log(
      `  ${"Symbol".padEnd(50)} ${"Expiry".padEnd(12)} ${"Last Date".padEnd(12)} ${"Missing From".padEnd(14)} Missing To`
    );
    console.log("  " + "-".repeat(112));
    for (const r of stale) {
      console.log(
        `  ${r.symbol.padEnd(50)} ${fmt(r.expiry_date).padEnd(12)} ${fmt(r.last_date).padEnd(12)} ${String(r.missing_from).padEnd(14)} ${r.missing_to}`
      );
    }
  }

  console.log(`\n  Total missing/stale: ${rows.length} active contracts`);
}

async function findMissingOptions(): Promise<void> {
  console.log("\n==================================================");
  console.log("  NSE OPTIONS — Missing / Stale Historical Data");
  console.log("==================================================");

  const maxRow = await prisma.$queryRaw<Array<{ max_date: Date | null }>>`
    SELECT MAX(date) AS max_date FROM market_data.nse_options
  `;
  const maxDate = maxRow[0]?.max_date;

  if (!maxDate) {
    console.log("  No options data found in nse_options at all.");
    return;
  }

  console.log(`  Latest date in nse_options: ${fmt(maxDate)}\n`);

  const rows = await prisma.$queryRaw<MissingFutOpt[]>`
    WITH per_symbol AS (
      SELECT symbol AS symbol_id, MAX(date) AS last_date
      FROM market_data.nse_options
      GROUP BY symbol
    )
    SELECT
      sl.id                              AS symbol_id,
      sl.instrument_id,
      sl.symbol,
      sl.segment,
      sl.expiry_date,
      sl.upstox_id,
      ps.last_date,
      CASE
        WHEN ps.last_date IS NULL THEN '2025-09-01'
        ELSE to_char(ps.last_date + INTERVAL '1 day', 'YYYY-MM-DD')
      END AS missing_from,
      to_char(${maxDate}::date, 'YYYY-MM-DD') AS missing_to
    FROM market_data.symbols_list sl
    LEFT JOIN per_symbol ps ON ps.symbol_id = sl.id
    WHERE
      sl.upstox_id IS NOT NULL
      AND sl.segment = 'OPT'
      AND sl.expiry_date >= CURRENT_DATE
      AND (ps.last_date IS NULL OR ps.last_date < ${maxDate}::date)
    ORDER BY ps.last_date ASC NULLS FIRST, sl.symbol
  `;

  if (rows.length === 0) {
    console.log("  ✅ All active options contracts are up to date.");
    return;
  }

  const neverSynced = rows.filter((r) => r.last_date === null);
  const stale = rows.filter((r) => r.last_date !== null);

  if (neverSynced.length > 0) {
    console.log(`  ❌ Never synced (${neverSynced.length} contracts):`);
    console.log(
      `  ${"Symbol".padEnd(60)} ${"Expiry".padEnd(12)} ${"Missing From".padEnd(14)} Missing To`
    );
    console.log("  " + "-".repeat(100));
    for (const r of neverSynced) {
      console.log(
        `  ${r.symbol.padEnd(60)} ${fmt(r.expiry_date).padEnd(12)} ${String(r.missing_from).padEnd(14)} ${r.missing_to}`
      );
    }
  }

  if (stale.length > 0) {
    console.log(`\n  ⚠️  Stale / partial data (${stale.length} contracts):`);
    console.log(
      `  ${"Symbol".padEnd(60)} ${"Expiry".padEnd(12)} ${"Last Date".padEnd(12)} ${"Missing From".padEnd(14)} Missing To`
    );
    console.log("  " + "-".repeat(116));
    for (const r of stale) {
      console.log(
        `  ${r.symbol.padEnd(60)} ${fmt(r.expiry_date).padEnd(12)} ${fmt(r.last_date).padEnd(12)} ${String(r.missing_from).padEnd(14)} ${r.missing_to}`
      );
    }
  }

  console.log(`\n  Total missing/stale: ${rows.length} active contracts`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const segments = args.length > 0 ? args : ["equity", "futures", "options"];

  console.log("\n🔍 Missing Historical Data Report");
  console.log(`📅 Generated at: ${new Date().toISOString()}`);
  console.log(`📊 Segments: ${segments.join(", ")}`);

  if (segments.includes("equity")) await findMissingEquity();
  if (segments.includes("futures")) await findMissingFutures();
  if (segments.includes("options")) await findMissingOptions();

  console.log("\n✅ Report complete.\n");
}

main()
  .then(() => prisma.$disconnect())
  .catch((err) => {
    console.error("❌ Script failed:", err);
    prisma.$disconnect();
    process.exit(1);
  });
