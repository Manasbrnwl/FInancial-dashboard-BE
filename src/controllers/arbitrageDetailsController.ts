import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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

    // Query to get the latest arbitrage data for the instrument
    const query = `
      WITH latest_tick_fut AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY "instrumentId", DATE("time")
                  ORDER BY id DESC
              ) rn
          FROM periodic_market_data."ticksDataNSEFUT"
          ${date ? `WHERE DATE("time") = '${date}'` : ''}
      ),
      filtered AS (
          SELECT
              il.id AS instrumentid,
              il.instrument_type AS name,
              DATE(tf.time) AS tick_date,
              substring(sl.symbol from '[0-9]{2}([A-Z]{3})FUT') AS expiry_month,
              sl.symbol,
              tf.ltp,
              CASE substring(sl.symbol from '[0-9]{2}([A-Z]{3})FUT')
                  WHEN 'JAN' THEN 1 WHEN 'FEB' THEN 2 WHEN 'MAR' THEN 3
                  WHEN 'APR' THEN 4 WHEN 'MAY' THEN 5 WHEN 'JUN' THEN 6
                  WHEN 'JUL' THEN 7 WHEN 'AUG' THEN 8 WHEN 'SEP' THEN 9
                  WHEN 'OCT' THEN 10 WHEN 'NOV' THEN 11 WHEN 'DEC' THEN 12
                  ELSE 13 END AS expiry_order
          FROM market_data.symbols_list sl
          INNER JOIN market_data.instrument_lists il
              ON sl.instrument_id = il.id
          INNER JOIN latest_tick_fut tf
              ON sl.id = tf."instrumentId" AND tf.rn = 1
          WHERE sl.segment = 'FUT' AND il.id = ${instrumentId}
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
              MAX(CASE WHEN symbol_rank = 1 THEN ltp END) AS price_1,
              MAX(CASE WHEN symbol_rank = 2 THEN symbol END) AS symbol_2,
              MAX(CASE WHEN symbol_rank = 2 THEN ltp END) AS price_2,
              MAX(CASE WHEN symbol_rank = 3 THEN symbol END) AS symbol_3,
              MAX(CASE WHEN symbol_rank = 3 THEN ltp END) AS price_3
          FROM ranked_symbols
          GROUP BY instrumentid, name, tick_date
          ORDER BY date DESC
          LIMIT 1
      )
      SELECT *,
          COALESCE(price_1 - price_2, 0) AS gap_1,
          COALESCE(price_2 - price_3, 0) AS gap_2
      FROM arbitrage_data;
    `;

    const result = await prisma.$queryRawUnsafe(query);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error fetching arbitrage details:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
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
    const query = `
      WITH latest_ticks AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY "instrumentId"
                  ORDER BY id DESC
              ) rn
          FROM periodic_market_data."ticksDataNSEFUT"
          WHERE "instrumentId" IN (
              SELECT id FROM market_data.symbols_list
              WHERE symbol = ANY($1)
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
      WHERE lt.rn = 1
      ORDER BY ARRAY_POSITION($1, sl.symbol);
    `;

    const result = await prisma.$queryRawUnsafe(query, symbolList);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error fetching live data:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

/**
 * Get filtered arbitrage data with pagination
 * Supports day-wise and hour-wise queries with gap filtering
 */
export const getFilteredArbitrageData = async (
  req: Request,
  res: Response
) => {
  try {
    const { instrumentId } = req.params;
    const {
      timeRange = "day",
      page = "1",
      limit = "180",
      gapFilter = "both",
      minGap,
      maxGap,
    } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    // Build the query based on timeRange
    const baseQuery = `
      WITH latest_tick_fut AS (
          SELECT *,
              ROW_NUMBER() OVER (
                  PARTITION BY "instrumentId", ${
                    timeRange === "hour"
                      ? "DATE_TRUNC('hour', \"time\")"
                      : "DATE(\"time\")"
                  }
                  ORDER BY id DESC
              ) rn
          FROM periodic_market_data."ticksDataNSEFUT"
      ),
      filtered AS (
          SELECT
              il.id AS instrumentid,
              il.instrument_type AS name,
              ${
                timeRange === "hour"
                  ? "DATE_TRUNC('hour', tf.time)"
                  : "DATE(tf.time)"
              } AS tick_date,
              substring(sl.symbol from '[0-9]{2}([A-Z]{3})FUT') AS expiry_month,
              sl.symbol,
              tf.ltp,
              CASE substring(sl.symbol from '[0-9]{2}([A-Z]{3})FUT')
                  WHEN 'JAN' THEN 1 WHEN 'FEB' THEN 2 WHEN 'MAR' THEN 3
                  WHEN 'APR' THEN 4 WHEN 'MAY' THEN 5 WHEN 'JUN' THEN 6
                  WHEN 'JUL' THEN 7 WHEN 'AUG' THEN 8 WHEN 'SEP' THEN 9
                  WHEN 'OCT' THEN 10 WHEN 'NOV' THEN 11 WHEN 'DEC' THEN 12
                  ELSE 13 END AS expiry_order
          FROM market_data.symbols_list sl
          INNER JOIN market_data.instrument_lists il
              ON sl.instrument_id = il.id
          INNER JOIN latest_tick_fut tf
              ON sl.id = tf."instrumentId" AND tf.rn = 1
          WHERE sl.segment = 'FUT' AND il.id = ${instrumentId}
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
              MAX(CASE WHEN symbol_rank = 1 THEN ltp END) AS price_1,
              MAX(CASE WHEN symbol_rank = 2 THEN symbol END) AS symbol_2,
              MAX(CASE WHEN symbol_rank = 2 THEN ltp END) AS price_2,
              MAX(CASE WHEN symbol_rank = 3 THEN symbol END) AS symbol_3,
              MAX(CASE WHEN symbol_rank = 3 THEN ltp END) AS price_3
          FROM ranked_symbols
          GROUP BY instrumentid, name, tick_date
      ),
      with_gaps AS (
          SELECT *,
              (price_1::numeric - price_2::numeric) AS gap_1,
              (price_2::numeric - price_3::numeric) AS gap_2
          FROM arbitrage_data
      )
      SELECT * FROM with_gaps
      WHERE 1=1
    `;

    // Add gap filtering
    let filterConditions = "";
    if (gapFilter === "positive") {
      filterConditions += " AND (gap_1 > 0 OR gap_2 > 0)";
    } else if (gapFilter === "negative") {
      filterConditions += " AND (gap_1 < 0 OR gap_2 < 0)";
    }

    // Add gap range filtering
    if (minGap) {
      filterConditions += ` AND (gap_1 >= ${minGap} OR gap_2 >= ${minGap})`;
    }
    if (maxGap) {
      filterConditions += ` AND (gap_1 <= ${maxGap} OR gap_2 <= ${maxGap})`;
    }

    const countQuery = baseQuery + filterConditions;
    const dataQuery =
      baseQuery +
      filterConditions +
      `
      ORDER BY date DESC
      LIMIT ${limitNum}
      OFFSET ${offset}
    `;

    // Execute both queries
    const [data, countResult] = await Promise.all([
      prisma.$queryRawUnsafe(dataQuery),
      prisma.$queryRawUnsafe(countQuery),
    ]);

    const totalCount = Array.isArray(countResult) ? countResult.length : 0;
    const totalPages = Math.ceil(totalCount / limitNum);

    // Calculate summary statistics - count individual gaps from both columns
    const positiveGapCount = Array.isArray(countResult)
      ? countResult.reduce((count: number, row: any) => {
          let gaps = 0;
          if (row.gap_1 > 0) gaps++;
          if (row.gap_2 > 0) gaps++;
          return count + gaps;
        }, 0)
      : 0;

    const negativeGapCount = Array.isArray(countResult)
      ? countResult.reduce((count: number, row: any) => {
          let gaps = 0;
          if (row.gap_1 < 0) gaps++;
          if (row.gap_2 < 0) gaps++;
          return count + gaps;
        }, 0)
      : 0;

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
    console.error("Error fetching filtered arbitrage data:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
