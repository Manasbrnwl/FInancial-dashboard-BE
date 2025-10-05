import { PrismaClient } from "@prisma/client";

export interface BatchInsertOptions {
  chunkSize?: number;
  logProgress?: boolean;
}

/**
 * Utility class for optimized batch database operations
 */
export class BatchInserter {
  private prisma: PrismaClient;
  private defaultChunkSize: number = 1000;

  constructor(prisma: PrismaClient) {
    this.prisma = prisma;
  }

  /**
   * Split array into chunks for batch processing
   */
  private chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Batch insert with chunking and error handling
   */
  async batchInsert<T>(
    tableName: string,
    data: T[],
    insertFunction: (chunk: T[]) => Promise<any>,
    options: BatchInsertOptions = {}
  ): Promise<{ inserted: number; errors: number }> {
    const { chunkSize = this.defaultChunkSize, logProgress = true } = options;

    if (data.length === 0) {
      return { inserted: 0, errors: 0 };
    }

    const chunks = this.chunk(data, chunkSize);
    let totalInserted = 0;
    let totalErrors = 0;

    if (logProgress) {
      console.log(`📊 Starting batch insert for ${tableName}: ${data.length} records in ${chunks.length} chunks`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        const result = await insertFunction(chunk);
        totalInserted += chunk.length;

        if (logProgress && (i + 1) % 10 === 0) {
          console.log(`✅ Processed ${i + 1}/${chunks.length} chunks for ${tableName}`);
        }
      } catch (error: any) {
        totalErrors += chunk.length;
        console.error(`❌ Error in chunk ${i + 1} for ${tableName}:`, error.message);

        // Try individual inserts for failed chunk to identify problematic records
        await this.retryChunkIndividually(chunk, insertFunction, tableName);
      }
    }

    if (logProgress) {
      console.log(`🎯 ${tableName} batch complete: ${totalInserted} inserted, ${totalErrors} errors`);
    }

    return { inserted: totalInserted, errors: totalErrors };
  }

  /**
   * Retry failed chunk with individual inserts to isolate errors
   */
  private async retryChunkIndividually<T>(
    chunk: T[],
    insertFunction: (data: T[]) => Promise<any>,
    tableName: string
  ): Promise<void> {
    console.log(`🔄 Retrying ${chunk.length} records individually for ${tableName}`);

    for (const record of chunk) {
      try {
        await insertFunction([record]);
      } catch (error: any) {
        console.error(`❌ Individual record failed for ${tableName}:`, error.message);
      }
    }
  }

  /**
   * Batch upsert instruments with deduplication and controlled concurrency
   */
  async batchUpsertInstruments(
    instruments: Array<{ exchange: string; instrument_type: string }>,
    options: BatchInsertOptions = {}
  ): Promise<void> {
    const { logProgress = true, chunkSize = 10 } = options;

    // Deduplicate instruments
    const uniqueInstruments = Array.from(
      new Map(
        instruments.map(item => [`${item.exchange}_${item.instrument_type}`, item])
      ).values()
    );

    if (uniqueInstruments.length === 0) {
      return;
    }

    if (logProgress) {
      console.log(`📋 Upserting ${uniqueInstruments.length} unique instruments`);
    }

    let successCount = 0;
    let errorCount = 0;

    // Process instruments sequentially in small chunks to avoid connection pool exhaustion
    const chunks = this.chunk(uniqueInstruments, chunkSize);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Process chunk sequentially to control database connections
      for (const instrument of chunk) {
        try {
          await this.prisma.instrument_lists.upsert({
            where: {
              exchange_instrument_type: {
                exchange: instrument.exchange,
                instrument_type: instrument.instrument_type,
              },
            },
            update: {},
            create: {
              exchange: instrument.exchange,
              instrument_type: instrument.instrument_type,
            },
          });
          successCount++;
        } catch (error: any) {
          errorCount++;
          if (logProgress && errorCount <= 5) {
            console.error(`❌ Instrument upsert failed for ${instrument.exchange}:${instrument.instrument_type}:`, error.message);
          }
        }
      }

      if (logProgress && chunks.length > 10 && (i + 1) % 10 === 0) {
        console.log(`📋 Processed ${i + 1}/${chunks.length} instrument chunks (${successCount} success, ${errorCount} errors)`);
      }
    }

    if (logProgress) {
      console.log(`✅ Instruments upsert completed: ${successCount} success, ${errorCount} errors`);
    }
  }

  /**
   * Batch upsert symbols into symbols_list table
   */
  async batchUpsertSymbolsList(
    symbolsData: Array<{ symbol: string; instrument_type: string; exchange: string; segment?: string }>,
    options: BatchInsertOptions = {}
  ): Promise<{ inserted: number; errors: number }> {
    const { logProgress = true, chunkSize = 50 } = options;

    if (symbolsData.length === 0) {
      return { inserted: 0, errors: 0 };
    }

    // Deduplicate symbols by instrument_type and symbol combination
    const uniqueSymbols = Array.from(
      new Map(
        symbolsData.map(item => [`${item.instrument_type}_${item.symbol}`, item])
      ).values()
    );

    if (logProgress) {
      console.log(`📋 Upserting ${uniqueSymbols.length} unique symbols into symbols_list`);
    }

    let successCount = 0;
    let errorCount = 0;

    // Process in chunks
    const chunks = this.chunk(uniqueSymbols, chunkSize);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      for (const symbolData of chunk) {
        try {
          // First, get the instrument_id from instrument_lists
          const instrument = await this.prisma.instrument_lists.findFirst({
            where: {
              exchange: symbolData.exchange,
              instrument_type: symbolData.instrument_type,
            },
            select: {
              id: true,
            },
          });

          if (!instrument) {
            if (logProgress && errorCount < 5) {
              console.warn(`⚠️ Instrument not found for ${symbolData.exchange}:${symbolData.instrument_type}`);
            }
            errorCount++;
            continue;
          }

          // Upsert symbol into symbols_list
          await this.prisma.symbols_list.upsert({
            where: {
              instrument_id_symbol: {
                instrument_id: instrument.id,
                symbol: symbolData.symbol,
              },
            },
            update: {
              segment: symbolData.segment,
            },
            create: {
              instrument_id: instrument.id,
              symbol: symbolData.symbol,
              segment: symbolData.segment,
            },
          });
          successCount++;
        } catch (error: any) {
          errorCount++;
          if (logProgress && errorCount <= 5) {
            console.error(`❌ Symbol upsert failed for ${symbolData.symbol}:`, error.message);
          }
        }
      }

      if (logProgress && chunks.length > 10 && (i + 1) % 10 === 0) {
        console.log(`📋 Processed ${i + 1}/${chunks.length} symbol chunks (${successCount} success, ${errorCount} errors)`);
      }
    }

    if (logProgress) {
      console.log(`✅ Symbols upsert completed: ${successCount} success, ${errorCount} errors`);
    }

    return { inserted: successCount, errors: errorCount };
  }

  /**
   * Batch insert with transaction and skipDuplicates
   */
  async batchInsertWithTransaction<T>(
    data: T[],
    insertFunction: (tx: any, chunk: T[]) => Promise<any>,
    options: BatchInsertOptions = {}
  ): Promise<{ inserted: number; errors: number }> {
    const { chunkSize = this.defaultChunkSize, logProgress = true } = options;

    if (data.length === 0) {
      return { inserted: 0, errors: 0 };
    }

    const chunks = this.chunk(data, chunkSize);
    let totalInserted = 0;
    let totalErrors = 0;

    if (logProgress) {
      console.log(`🔄 Starting transaction-based batch insert: ${chunks.length} chunks`);
    }

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        await this.prisma.$transaction(async (tx) => {
          await insertFunction(tx, chunk);
        });
        totalInserted += chunk.length;

        if (logProgress && (i + 1) % 5 === 0) {
          console.log(`⚡ Completed ${i + 1}/${chunks.length} transaction chunks`);
        }
      } catch (error: any) {
        totalErrors += chunk.length;
        console.error(`❌ Transaction chunk ${i + 1} failed:`, error.message);
      }
    }

    return { inserted: totalInserted, errors: totalErrors };
  }
}

/**
 * Create a singleton batch inserter instance
 */
export function createBatchInserter(prisma: PrismaClient): BatchInserter {
  return new BatchInserter(prisma);
}