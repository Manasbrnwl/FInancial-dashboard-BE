import { Request, Response } from "express";
import prisma from "../config/prisma";

/**
 * Get aggregated arbitrage history for a specific instrument
 * Returns daily average gaps and volume for the near month contract
 */
export const getSymbolArbitrageHistory = async (req: Request, res: Response) => {
    try {
        const { instrumentId } = req.params;
        const { startDate, endDate } = req.query;

        if (!instrumentId) {
            return res.status(400).json({
                success: false,
                message: "instrumentId is required",
            });
        }

        // 1. Fetch aggregated gap data from gap_time_series
        // Group by date, calculate AVG gap_1, AVG gap_2
        const gapQuery = `
      SELECT
        date,
        AVG(gap_1) as avg_gap_1,
        AVG(gap_2) as avg_gap_2,
        MIN(gap_1) as min_gap_1,
        MAX(gap_1) as max_gap_1,
        MIN(gap_2) as min_gap_2,
        MAX(gap_2) as max_gap_2
      FROM market_data.gap_time_series
      WHERE instrument_id = ${instrumentId}
      ${startDate ? `AND date >= '${startDate}'::date` : ""}
      ${endDate ? `AND date <= '${endDate}'::date` : ""}
      GROUP BY date
      ORDER BY date DESC
    `;

        // 2. Fetch volume data from nse_futures for the NEAR MONTH contract
        // We need to find the Near Month symbol for this instrumentId on each date
        // This is a bit complex because "Near Month" changes.
        // Simplified approach: Join with symbols_list to find the symbol with rank 1 (Near)
        // and then get volume from nse_futures.

        // Actually, a cleaner way is to do it in one query or separate queries.
        // Let's try a separate query for volume to keep it manageable, then merge in JS.

        const volumeQuery = `
      WITH daily_ranks AS (
        SELECT 
            nf.date,
            nf.symbol,
            nf.volume,
            sl.expiry_date,
            ROW_NUMBER() OVER (PARTITION BY nf.date ORDER BY sl.expiry_date ASC) as rn
        FROM market_data.nse_futures nf
        JOIN market_data.symbols_list sl ON nf.symbol = sl.id
        WHERE sl.instrument_id = ${instrumentId}
        AND sl.segment = 'FUT'
        ${startDate ? `AND nf.date >= '${startDate}'::date` : ""}
        ${endDate ? `AND nf.date <= '${endDate}'::date` : ""}
      )
      SELECT 
        date,
        volume
      FROM daily_ranks
      WHERE rn = 1 -- Select only the Near Month contract
      ORDER BY date DESC
    `;

        const [gapData, volumeData] = await Promise.all([
            prisma.$queryRawUnsafe(gapQuery),
            prisma.$queryRawUnsafe(volumeQuery),
        ]);

        // 3. Merge data
        const mergedData = (gapData as any[]).map((gapRow) => {
            const volRow = (volumeData as any[]).find(
                (v) => new Date(v.date).getTime() === new Date(gapRow.date).getTime()
            );
            return {
                date: gapRow.date,
                avgGap1: gapRow.avg_gap_1,
                avgGap2: gapRow.avg_gap_2,
                minGap1: gapRow.min_gap_1,
                maxGap1: gapRow.max_gap_1,
                minGap2: gapRow.min_gap_2,
                maxGap2: gapRow.max_gap_2,
                volume: volRow ? volRow.volume : 0,
            };
        });

        return res.status(200).json({
            success: true,
            data: mergedData,
        });
    } catch (error) {
        console.error("Error fetching arbitrage history:", error);
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
