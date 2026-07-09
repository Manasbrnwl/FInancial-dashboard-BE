import dotenv from "dotenv";
dotenv.config();

import prisma from "../config/prisma";

// Note: TimescaleDB on this instance does not support CREATE INDEX CONCURRENTLY
// on hypertables ("hypertables do not support concurrent index creation"), so these
// run as plain CREATE INDEX. All three target tables are small (ticksDataNSEFUT ~195MB
// /3.5M rows; ohlcDataNSE/ohlcEQDataBSE a few MB) so the brief ACCESS EXCLUSIVE lock
// during the build is expected to last seconds, not minutes.
const STATEMENTS: { name: string; sql: string }[] = [
  {
    name: "idx_cover_ticks_nsefut",
    sql: `CREATE INDEX IF NOT EXISTS idx_cover_ticks_nsefut
          ON periodic_market_data."ticksDataNSEFUT" ("instrumentId", id DESC, ltp, volume)`,
  },
  {
    name: "idx_ohlc_nse_inst_time",
    sql: `CREATE INDEX IF NOT EXISTS idx_ohlc_nse_inst_time
          ON periodic_market_data."ohlcDataNSE" ("instrumentId", time DESC)`,
  },
  {
    name: "idx_ohlc_bse_inst_time",
    sql: `CREATE INDEX IF NOT EXISTS idx_ohlc_bse_inst_time
          ON periodic_market_data."ohlcEQDataBSE" ("instrumentId", time DESC)`,
  },
];

async function main() {
  for (const { name, sql } of STATEMENTS) {
    const start = Date.now();
    console.log(`Creating index ${name}...`);
    try {
      await prisma.$executeRawUnsafe(sql);
      console.log(`  done in ${Date.now() - start}ms`);
    } catch (err: any) {
      console.error(`  FAILED: ${err.message}`);
      throw err;
    }
  }
  console.log("All indexes created.");
}

main()
  .catch((err) => {
    console.error("Index creation aborted:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
