import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { devError, prodError } from "../utils/errorLogger";

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

        const numericInstrumentId = Number(instrumentId);
        if (Number.isNaN(numericInstrumentId)) {
            return res.status(400).json({
                success: false,
                message: "instrumentId must be a valid number",
            });
        }

        // 1. Fetch aggregated gap data from gap_time_series
        // Group by date, calculate AVG gap_1, AVG gap_2
        const gapFilters: Prisma.Sql[] = [];
        gapFilters.push(Prisma.sql`instrument_id = ${numericInstrumentId}`);
        
        if (startDate) {
            gapFilters.push(Prisma.sql`date >= ${new Date(startDate as string)}`);
        }
        if (endDate) {
            gapFilters.push(Prisma.sql`date <= ${new Date(endDate as string)}`);
        }

        const gapQuery = Prisma.sql`
          SELECT
            date,
            AVG(gap_1) as avg_gap_1,
            AVG(gap_2) as avg_gap_2,
            MIN(gap_1) as min_gap_1,
            MAX(gap_1) as max_gap_1,
            MIN(gap_2) as min_gap_2,
            MAX(gap_2) as max_gap_2
          FROM market_data.gap_time_series
          WHERE ${Prisma.join(gapFilters, " AND ")}
          GROUP BY date
          ORDER BY date DESC
        `;

        // 2. Fetch volume data from nse_futures for the NEAR MONTH contract
        const volFilters: Prisma.Sql[] = [];
        volFilters.push(Prisma.sql`sl.instrument_id = ${numericInstrumentId}`);
        volFilters.push(Prisma.sql`sl.segment = 'FUT'`);
        
        if (startDate) {
            volFilters.push(Prisma.sql`nf.date >= ${new Date(startDate as string)}`);
        }
        if (endDate) {
            volFilters.push(Prisma.sql`nf.date <= ${new Date(endDate as string)}`);
        }

        const volumeQuery = Prisma.sql`
          WITH daily_ranks AS (
            SELECT 
                nf.date,
                nf.symbol,
                nf.volume,
                sl.expiry_date,
                ROW_NUMBER() OVER (PARTITION BY nf.date ORDER BY sl.expiry_date ASC) as rn
            FROM market_data.nse_futures nf
            JOIN market_data.symbols_list sl ON nf.symbol = sl.id
            WHERE ${Prisma.join(volFilters, " AND ")}
          )
          SELECT 
            date,
            volume
          FROM daily_ranks
          WHERE rn = 1 -- Select only the Near Month contract
          ORDER BY date DESC
        `;

        const [gapData, volumeData] = await Promise.all([
            prisma.$queryRaw<any[]>(gapQuery),
            prisma.$queryRaw<any[]>(volumeQuery),
        ]);

        // 3. Merge data
        const mergedData = gapData.map((gapRow) => {
            const volRow = volumeData.find(
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
        devError("Error fetching arbitrage history:", error);
        prodError("Error fetching arbitrage history");
        return res.status(500).json({
            success: false,
            message: "Internal server error",
            ...(process.env.NODE_ENV !== "production" && { error: error instanceof Error ? error.message : "Unknown error" }),
        });
    }
};
