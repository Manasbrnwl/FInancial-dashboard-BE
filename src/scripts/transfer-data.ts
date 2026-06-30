import { PrismaClient } from '@prisma/client';

async function main() {
  // Pass table names via CLI, e.g., npx ts-node src/scripts/transfer-data.ts bse_equity nse_equity
  // Or hardcode them in the array below if no arguments are provided.
  let tableNames = process.argv.slice(2);

  if (tableNames.length === 0) {
    // Default list of all tables from your schema
    tableNames = [
      'nse_futures',
      'nse_options',
      // 'instrument_lists',
      // 'instruments_expiry',
      'bhavcopy_uploaded',
      'dates_missed',
      // 'symbols_list',
      // 'ohlcDataNSE',
      'ohlcEQDataBSE',
      'ticksDataNSEEQ',
      'ticksDataNSEFUT',
      'ticksDataNSEOPT',
      'gap_time_series',
      'gap_alerts',
      'gap_alert_config',
      'margin_calculations',
      'covered_calls_gaps',
      'app_config',
      'covered_call_alerts',
      'covered_call_alert_config'
    ];
  }

  const sourceUrl = process.env.SOURCE_DATABASE_URL;
  const targetUrl = process.env.TARGET_DATABASE_URL;

  if (!sourceUrl || !targetUrl) {
    console.error('Error: SOURCE_DATABASE_URL and TARGET_DATABASE_URL must be set in Environment Variables.');
    process.exit(1);
  }

  const sourceDb = new PrismaClient({
    datasources: { db: { url: sourceUrl } },
  });

  const targetDb = new PrismaClient({
    datasources: { db: { url: targetUrl } },
  });

  try {
    for (const tableName of tableNames) {
      console.log(`\n======================================`);
      console.log(`Starting transfer for table: ${tableName}`);
      
      const sourceModel = (sourceDb as Record<string, any>)[tableName];
      const targetModel = (targetDb as Record<string, any>)[tableName];

      if (!sourceModel || !targetModel) {
        console.error(`Error: Model "${tableName}" not found in Prisma schema. Skipping.`);
        continue;
      }

      const totalRecords = await sourceModel.count();
      console.log(`Total records to transfer: ${totalRecords}`);

      if (totalRecords === 0) {
         console.log(`No records found in ${tableName}. Moving to next.`);
         continue;
      }

      const BATCH_SIZE = 5000;

      for (let skip = 0; skip < totalRecords; skip += BATCH_SIZE) {
        console.log(`[${tableName}] Fetching records ${skip} to ${Math.min(skip + BATCH_SIZE, totalRecords) - 1}...`);

        const records = await sourceModel.findMany({
          skip: skip,
          take: BATCH_SIZE,
        });

        if (records.length === 0) break;

        console.log(`[${tableName}] Inserting ${records.length} records into target DB...`);

        await targetModel.createMany({
          data: records,
          skipDuplicates: true, // Prevents failure if rerun on same data
        });

        console.log(`[${tableName}] Progress: ${Math.min(skip + records.length, totalRecords)} / ${totalRecords}`);
      }

      console.log(`Transfer complete for table: ${tableName}!`);
    }

    console.log(`\nAll tables processed successfully!`);

  } catch (error) {
    console.error('Transfer failed: ', error);
    process.exit(1);
  } finally {
    await sourceDb.$disconnect();
    await targetDb.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
