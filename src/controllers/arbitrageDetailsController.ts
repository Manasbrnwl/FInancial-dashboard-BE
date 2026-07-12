import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { devError, prodError } from "../utils/errorLogger";

const ENV = process.env.NODE_ENV;

/**
 * Get arbitrage details for a specific instrument and date
 * Returns the selected row data from the arbitrage table
 */
export const getArbitrageDetails = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.params;
    const { date } = req.query;

    if (!instrumentId) {
      return res.status(400).json({
        success: false,
        message: "instrumentId is required",
      });
    }

    const numericId = Number(instrumentId);
    if (Number.isNaN(numericId)) {
      return res.status(400).json({
        success: false,
        message: "instrumentId must be a valid number",
      });
    }

    const latestTickFutWhere = date
      ? Prisma.sql`AND DATE("time") = ${new Date(date as string)}`
      : Prisma.empty;

    const tickDateExpr = date
      ? Prisma.sql`DATE(tf.time)`
      : Prisma.sql`tf.time`;

    // Query to get the latest arbitrage data for the instrument
    const query = Prisma.sql`
      WITH relevant_symbols AS (
          SELECT id FROM market_data.symbols_list
          WHERE instrument_id = ${numericId} AND segment = 'FUT' AND upstox_id IS NOT NULL
      ),
      latest_tick_fut AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY "instrumentId", DATE("time")
                  ORDER BY id DESC
              ) rn
          FROM periodic_market_data."ticksDataNSEFUT"
          WHERE "instrumentId" IN (SELECT id FROM relevant_symbols)
          ${latestTickFutWhere}
      ),
      filtered AS (
          SELECT
              il.id AS instrumentid,
              il.instrument_type AS name,
              ${tickDateExpr} AS tick_date,
              substring(sl.symbol from '[0-9]{2}([A-Z]{3})FUT') AS expiry_month,
              sl.symbol,
              sl.upstox_id,
              tf.ltp,
              sl.expiry_date as expiry_order
          FROM market_data.symbols_list sl
          INNER JOIN market_data.instrument_lists il
              ON sl.instrument_id = il.id
          INNER JOIN latest_tick_fut tf
              ON sl.id = tf."instrumentId" AND tf.rn = 1
          WHERE sl.segment = 'FUT' AND il.id = ${numericId} and sl.upstox_id is not null
      ),
      ranked_symbols AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY instrumentid, tick_date
                  ORDER BY expiry_order
              ) AS symbol_rank
          FROM filtered
      ),
      arbitrage_data AS (
          SELECT
              instrumentid,
              name,
              tick_date AS date,
              MAX(CASE WHEN symbol_rank = 1 THEN symbol END) AS symbol_1,
              MAX(CASE WHEN symbol_rank = 1 THEN upstox_id END) AS upstox_id_1,
              MAX(CASE WHEN symbol_rank = 1 THEN ltp END) AS price_1,
              MAX(CASE WHEN symbol_rank = 2 THEN symbol END) AS symbol_2,
              MAX(CASE WHEN symbol_rank = 2 THEN upstox_id END) AS upstox_id_2,
              MAX(CASE WHEN symbol_rank = 2 THEN ltp END) AS price_2,
              MAX(CASE WHEN symbol_rank = 3 THEN symbol END) AS symbol_3,
              MAX(CASE WHEN symbol_rank = 3 THEN upstox_id END) AS upstox_id_3,
              MAX(CASE WHEN symbol_rank = 3 THEN ltp END) AS price_3
          FROM ranked_symbols
          GROUP BY instrumentid, name, tick_date
          ORDER BY date DESC
          LIMIT 1
      )
      SELECT *,
          COALESCE(price_1::numeric - price_2::numeric, 0) AS gap_1,
          COALESCE(price_2::numeric - price_3::numeric, 0) AS gap_2
      FROM arbitrage_data;
    `;

    const result = await prisma.$queryRaw<any[]>(query);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    devError("Error fetching arbitrage details:", error);
    prodError("Error fetching arbitrage details");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { error: error instanceof Error ? error.message : "Unknown error" }),
    });
  }
};

/**
 * Get live data for multiple symbols
 * Fetches real-time tick data for the 3 symbols in the arbitrage
 */
export const getLiveDataForSymbols = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.params;
    const { symbols } = req.query; // Comma-separated symbol list

    if (!symbols || typeof symbols !== "string") {
      return res.status(400).json({
        success: false,
        message: "symbols query parameter is required (comma-separated)",
      });
    }

    const symbolList = symbols.split(",").map((s) => s.trim());

    // Get the latest tick data for each symbol
    const query = Prisma.sql`
      WITH latest_ticks AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY "instrumentId"
                  ORDER BY id DESC
              ) rn
          FROM periodic_market_data."ticksDataNSEFUT"
          WHERE "instrumentId" IN (
              SELECT id FROM market_data.symbols_list
              WHERE symbol = ANY(${symbolList})
          )
      )
      SELECT
          sl.symbol,
          lt.time,
          lt.ltp,
          lt.volume,
          lt.oi,
          lt.ltq,
          lt."avgTradedPrice",
          lt.tbq,
          lt.tsq,
          lt.open,
          lt.high,
          lt.low,
          lt.close,
          lt."totalBuyQty",
          lt."totalSellQty"
      FROM latest_ticks lt
      INNER JOIN market_data.symbols_list sl
          ON lt."instrumentId" = sl.id
      WHERE lt.rn = 1 and sl.upstox_id is not null
      ORDER BY ARRAY_POSITION(${symbolList}, sl.symbol);
    `;

    const result = await prisma.$queryRaw<any[]>(query);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    devError("Error fetching live data:", error);
    prodError("Error fetching live data");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { error: error instanceof Error ? error.message : "Unknown error" }),
    });
  }
};

/**
 * Get filtered arbitrage data with pagination
 * Supports day-wise and hour-wise queries with gap filtering
 */
export const getFilteredArbitrageData = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.params;
    const {
      timeRange = "day",
      page = "1",
      limit = "180",
      gapFilter = "both",
      minGap,
      maxGap,
      startDate,
      endDate,
    } = req.query;

    const numericId = Number(instrumentId);
    if (Number.isNaN(numericId)) {
      return res.status(400).json({
        success: false,
        message: "instrumentId must be a valid number",
      });
    }

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.max(1, Math.min(500, parseInt(limit as string) || 180));
    const offset = (pageNum - 1) * limitNum;

    // Build base queries using Prisma.sql
    const baseQuerydaily = Prisma.sql`
      WITH relevant_symbols AS (
          SELECT id FROM market_data.symbols_list
          WHERE instrument_id = ${numericId} AND segment = 'FUT' AND upstox_id IS NOT NULL
      ),
      latest_tick_fut AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY underlying, symbol, date
                  ORDER BY id DESC
              ) rn
          FROM market_data.nse_futures
          WHERE symbol::numeric IN (SELECT id FROM relevant_symbols)
      ),
      filtered AS (
          SELECT
              il.id AS instrumentid,
              il.instrument_type AS name,
              tf.date correct_time,
              DATE(tf.date) AS tick_date,
              substring(sl.symbol from '[0-9]{2}([A-Z]{3})FUT') AS expiry_month,
              sl.symbol,
              sl.upstox_id,
              tf.close ltp,
              sl.expiry_date as expiry_order
          FROM market_data.symbols_list sl
          INNER JOIN market_data.instrument_lists il
              ON sl.instrument_id = il.id
          INNER JOIN latest_tick_fut tf
              ON sl.id = tf.symbol::numeric AND tf.rn = 1
          WHERE sl.segment = 'FUT' AND il.id = ${numericId} and sl.upstox_id is not null
      ),
      ranked_symbols AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY instrumentid, tick_date 
                  ORDER BY expiry_order
              ) as symbol_rank
          FROM filtered
      ),
      arbitrage_data AS (
          SELECT
              instrumentid,
              name,
              TO_CHAR(tick_date, 'yyyy-mm-dd HH12:MI AM') AS date,
              MAX(CASE WHEN symbol_rank = 1 THEN symbol END) as symbol_1,
              MAX(CASE WHEN symbol_rank = 1 THEN upstox_id END) as upstox_id_1,
              MAX(CASE WHEN symbol_rank = 1 THEN ltp END) as price_1,
              MAX(CASE WHEN symbol_rank = 2 THEN symbol END) as symbol_2,
              MAX(CASE WHEN symbol_rank = 2 THEN upstox_id END) as upstox_id_2,
              MAX(CASE WHEN symbol_rank = 2 THEN ltp END) as price_2,
              MAX(CASE WHEN symbol_rank = 3 THEN symbol END) as symbol_3,
              MAX(CASE WHEN symbol_rank = 3 THEN upstox_id END) as upstox_id_3,
              MAX(CASE WHEN symbol_rank = 3 THEN ltp END) as price_3
          FROM ranked_symbols
          GROUP BY instrumentid, name, tick_date
      ),
      with_gaps AS (
          SELECT *,
              COUNT(*) OVER() AS full_count,
              (price_1::numeric - price_2::numeric) AS gap_1,
              (price_2::numeric - price_3::numeric) AS gap_2
          FROM arbitrage_data
      )
    `;

    const baseQueryhourly = Prisma.sql`
      WITH relevant_symbols AS (
          SELECT id FROM market_data.symbols_list
          WHERE instrument_id = ${numericId} AND segment = 'FUT' AND upstox_id IS NOT NULL
      ),
      latest_tick_fut AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY "instrumentId", DATE_TRUNC('minute', time)
                  ORDER BY id DESC
              ) rn
          FROM periodic_market_data."ticksDataNSEFUT"
          WHERE "instrumentId" IN (SELECT id FROM relevant_symbols)
      ),
      filtered AS (
          SELECT
              il.id AS instrumentid,
              il.instrument_type AS name,
              tf.time correct_time,
              DATE_TRUNC('minute', tf.time) AS tick_date,
              substring(sl.symbol from '[0-9]{2}([A-Z]{3})FUT') AS expiry_month,
              substring(sl.symbol from '([0-9]{2})[A-Z]{3}FUT') AS expiry_year,
              sl.symbol,
              sl.upstox_id,
              tf.ltp,
              sl.expiry_date as expiry_order
          FROM market_data.symbols_list sl
          INNER JOIN market_data.instrument_lists il
              ON sl.instrument_id = il.id
          INNER JOIN latest_tick_fut tf
              ON sl.id = tf."instrumentId" AND tf.rn = 1
          WHERE sl.segment = 'FUT' AND il.id = ${numericId} and sl.upstox_id is not null
      ),
      prepared AS (
          SELECT *,
              CASE UPPER(expiry_month)
                  WHEN 'JAN' THEN 1 WHEN 'FEB' THEN 2 WHEN 'MAR' THEN 3
                  WHEN 'APR' THEN 4 WHEN 'MAY' THEN 5 WHEN 'JUN' THEN 6
                  WHEN 'JUL' THEN 7 WHEN 'AUG' THEN 8 WHEN 'SEP' THEN 9
                  WHEN 'OCT' THEN 10 WHEN 'NOV' THEN 11 WHEN 'DEC' THEN 12
              END AS expiry_month_num,
              (2000 + expiry_year::int) AS expiry_full_year,
              ((2000 + expiry_year::int) * 12 +
               CASE UPPER(expiry_month)
                  WHEN 'JAN' THEN 1 WHEN 'FEB' THEN 2 WHEN 'MAR' THEN 3
                  WHEN 'APR' THEN 4 WHEN 'MAY' THEN 5 WHEN 'JUN' THEN 6
                  WHEN 'JUL' THEN 7 WHEN 'AUG' THEN 8 WHEN 'SEP' THEN 9
                  WHEN 'OCT' THEN 10 WHEN 'NOV' THEN 11 WHEN 'DEC' THEN 12
               END
              ) AS expiry_abs,
              (EXTRACT(YEAR FROM correct_time)::int * 12 +
               EXTRACT(MONTH FROM correct_time)::int
              ) AS current_abs
          FROM filtered
      ),
      ranked_symbols AS (
          SELECT *,
              (expiry_abs - current_abs + 1) AS symbol_rank
          FROM prepared
      ),
      arbitrage_data AS (
          SELECT
              instrumentid,
              name,
              TO_CHAR(DATE_TRUNC('minute', tick_date) - ((EXTRACT(MINUTE FROM tick_date)::int % 5) * INTERVAL '1 minute'), 'yyyy-mm-dd HH12:MI AM') AS date,
              MAX(CASE WHEN symbol_rank = 1 THEN symbol END) as symbol_1,
              MAX(CASE WHEN symbol_rank = 1 THEN upstox_id END) as upstox_id_1,
              MAX(CASE WHEN symbol_rank = 1 THEN correct_time END) as rtime_1,
              MAX(CASE WHEN symbol_rank = 1 THEN ltp END) as price_1,
              MAX(CASE WHEN symbol_rank = 2 THEN symbol END) as symbol_2,
              MAX(CASE WHEN symbol_rank = 2 THEN upstox_id END) as upstox_id_2,
              MAX(CASE WHEN symbol_rank = 2 THEN correct_time END) as rtime_2,
              MAX(CASE WHEN symbol_rank = 2 THEN ltp END) as price_2,
              MAX(CASE WHEN symbol_rank = 3 THEN symbol END) as symbol_3,
              MAX(CASE WHEN symbol_rank = 3 THEN upstox_id END) as upstox_id_3,
              MAX(CASE WHEN symbol_rank = 3 THEN correct_time END) as rtime_3,
              MAX(CASE WHEN symbol_rank = 3 THEN ltp END) as price_3
          FROM ranked_symbols
          GROUP BY instrumentid, name, DATE_TRUNC('minute', tick_date) - ((EXTRACT(MINUTE FROM tick_date)::int % 5) * INTERVAL '1 minute')
      ),
      with_gaps AS (
          SELECT *,
              COUNT(*) OVER() AS full_count,
              TO_CHAR(rtime_1, 'HH12:MI:SS AM') AS time_1,
              TO_CHAR(rtime_2, 'HH12:MI:SS AM') AS time_2,
              TO_CHAR(rtime_3, 'HH12:MI:SS AM') AS time_3,
              (price_1::numeric - price_2::numeric) AS gap_1,
              (price_2::numeric - price_3::numeric) AS gap_2,
              ABS(EXTRACT(EPOCH FROM (rtime_1::timestamp - rtime_2::timestamp))) AS diff_12,
              ABS(EXTRACT(EPOCH FROM (rtime_2::timestamp - rtime_3::timestamp))) AS diff_23
          FROM arbitrage_data
      )
    `;

    const filters: Prisma.Sql[] = [];

    if (timeRange === "hour") {
      filters.push(Prisma.sql`((diff_12 >= 0 AND diff_12 <= 15) OR (diff_23 >= 0 AND diff_23 <= 15))`);
    }

    if (gapFilter === "positive") {
      filters.push(Prisma.sql`(gap_1 > 0 OR gap_2 > 0)`);
    } else if (gapFilter === "negative") {
      filters.push(Prisma.sql`(gap_1 < 0 OR gap_2 < 0)`);
    }

    // Add gap range filtering
    if (minGap && maxGap) {
      filters.push(Prisma.sql`((gap_1 >= ${Number(minGap)} AND gap_1 <= ${Number(maxGap)}) OR (gap_2 >= ${Number(minGap)} AND gap_2 <= ${Number(maxGap)}) OR gap_1 IS NULL OR gap_2 IS NULL)`);
    } else if (minGap) {
      filters.push(Prisma.sql`((gap_1 >= ${Number(minGap)}) OR (gap_2 >= ${Number(minGap)}) OR gap_1 IS NULL OR gap_2 IS NULL)`);
    } else if (maxGap) {
      filters.push(Prisma.sql`((gap_1 <= ${Number(maxGap)}) OR (gap_2 <= ${Number(maxGap)}) OR gap_1 IS NULL OR gap_2 IS NULL)`);
    } else {
      // Default to a permissive range so initial load is not over-filtered
      filters.push(Prisma.sql`((gap_1 >= -1000 AND gap_1 <= 1000) OR (gap_2 >= -1000 AND gap_2 <= 1000) OR gap_1 IS NULL OR gap_2 IS NULL)`);
    }

    // Add date range filtering
    if (startDate) {
      filters.push(Prisma.sql`date::date >= ${new Date(startDate as string)}`);
    }
    if (endDate) {
      if (timeRange === "hour") {
        filters.push(Prisma.sql`date::date <= ${new Date(endDate as string)}::date + interval '1 day'`);
      } else {
        filters.push(Prisma.sql`date::date <= ${new Date(endDate as string)}`);
      }
    }

    const cteSql = timeRange === "hour" ? baseQueryhourly : baseQuerydaily;
    const filterSql = filters.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`
      : Prisma.empty;

    const dataQuery = Prisma.sql`
      ${cteSql}
      SELECT * FROM with_gaps
      ${filterSql}
      ORDER BY date DESC
      LIMIT ${limitNum}
      OFFSET ${offset}
    `;

    // Execute query securely
    const data: any[] = await prisma.$queryRaw<any[]>(dataQuery);

    const totalCount = data.length > 0 ? Number(data[0].full_count) : 0;
    const totalPages = Math.ceil(totalCount / limitNum);

    const positiveGapCount = 0;
    const negativeGapCount = 0;

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages,
        hasMore: pageNum < totalPages,
      },
      summary: {
        positiveGapCount,
        negativeGapCount,
        totalCount,
      },
    });
  } catch (error) {
    devError("Error fetching filtered arbitrage data:", error);
    prodError("Error fetching filtered arbitrage data");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { error: error instanceof Error ? error.message : "Unknown error" }),
    });
  }
};
