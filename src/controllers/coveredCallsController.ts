import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { devError, prodError } from "../utils/errorLogger";

export const getCoveredCallsData = async (req: Request, res: Response) => {
  try {
    // Get pagination and filter parameters
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit as string) || 100));
    const offset = (page - 1) * limit;
    const underlying = req.query.underlying as string;
    const optionType = req.query.optionType as string;
    const minOtm = req.query.minOtm ? parseFloat(req.query.minOtm as string) : null;
    const maxOtm = req.query.maxOtm ? parseFloat(req.query.maxOtm as string) : null;
    const minPremium = req.query.minPremium ? parseFloat(req.query.minPremium as string) : null;
    const maxPremium = req.query.maxPremium ? parseFloat(req.query.maxPremium as string) : null;
    const expiryMonth = req.query.expiryMonth as string;

    // Build filter conditions using Prisma.sql
    const filters: Prisma.Sql[] = [];
    filters.push(Prisma.sql`rn = 1`);

    if (underlying) {
      filters.push(Prisma.sql`underlying ILIKE ${`%${underlying}%`}`);
    }
    if (optionType) {
      filters.push(Prisma.sql`option_type = ${optionType}`);
    }
    if (minOtm !== null) {
      filters.push(Prisma.sql`otm >= ${minOtm}`);
    }
    if (maxOtm !== null) {
      filters.push(Prisma.sql`otm <= ${maxOtm}`);
    }
    if (minPremium !== null) {
      filters.push(Prisma.sql`monthly_premium >= ${minPremium}`);
    }
    if (maxPremium !== null) {
      filters.push(Prisma.sql`monthly_premium <= ${maxPremium}`);
    }
    if (expiryMonth && expiryMonth !== "ALL") {
      filters.push(Prisma.sql`trim(expiry_month) = ${expiryMonth.trim()}`);
    }

    const whereClause = filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;

    // Get paginated and filtered data
    const coveredCallsData = await prisma.$queryRaw<
      Array<{
        id: number;
        underlying: string;
        underlying_price: number;
        expiry_month: string;
        time: string;
        premium: number;
        volume: number;
        strike: number;
        option_type: string;
        otm: number;
        premium_percentage: number;
        monthly_premium: number;
        full_count: bigint;
      }>
    >`WITH latest_tick_opt AS (
        SELECT DISTINCT ON ("instrumentId")
            "instrumentId", ltp, volume, time
        FROM periodic_market_data."ticksDataNSEOPT"
        WHERE time >= CURRENT_DATE - INTERVAL '3 days'
        ORDER BY "instrumentId", id DESC
    ),
    latest_tick_eq AS (
        SELECT DISTINCT ON ("instrumentId")
       		"instrumentId", ltp, time
 		FROM periodic_market_data."ticksDataNSEEQ"
        WHERE time >= CURRENT_DATE - INTERVAL '3 days'
        ORDER BY "instrumentId", id DESC
    ),
    strike_extraction AS (
        SELECT
            s.id,
            s.instrument_id,
            s.symbol,
            s.strike::numeric strike,
            s.option_type,
            s.expiry_month,
            s.expiry_date
        FROM market_data.symbols_list s
        WHERE s.segment = 'OPT'
        AND s.expiry_date >= CURRENT_DATE
        AND s.upstox_id is not null
    ),
    with_calcs AS (
        SELECT
            i.id as id,
            i.instrument_type AS underlying,
            se.expiry_month AS expiry_month,
            e.ltp::numeric AS underlying_price,
            TO_CHAR(o.time, 'yyyy-mm-dd HH12:MI AM') AS time,
            o.ltp::numeric AS premium,
            o.volume,
            se.strike,
            se.option_type,
            ROUND(((se.strike::numeric / e.ltp::numeric) - 1) * 100, 2) * -1 AS otm,
            ROUND((o.ltp::numeric / e.ltp::numeric) * 100, 2) AS premium_percentage,
            COALESCE(ROUND((((o.ltp::numeric / e.ltp::numeric) * 100) * 30)/NULLIF((se.expiry_date - date(o.time)), 0),2),0) AS monthly_premium,
            dense_rank() over (partition by i.instrument_type order by date(o.time) desc) rn
        FROM market_data.instrument_lists i
        JOIN strike_extraction se ON i.id = se.instrument_id
        JOIN latest_tick_opt o ON se.id = o."instrumentId"       
 		JOIN latest_tick_eq e ON e."instrumentId" = i.id
 	)
    SELECT
        id,
        underlying,
        expiry_month,
        time,
        underlying_price,
        premium,
        volume,
        strike,
        option_type,
        otm,
        premium_percentage,
        monthly_premium,
        COUNT(*) OVER() AS full_count
    FROM with_calcs
    ${whereClause}
    ORDER BY underlying, strike
    LIMIT ${limit}
    OFFSET ${offset}
    `;

    const totalCount = coveredCallsData.length > 0 ? Number((coveredCallsData[0] as any).full_count) : 0;

    // Transform the data to proper format with type conversions
    const transformedData = coveredCallsData.map((item) => ({
      id: item.id,
      underlyingSymbol: item.underlying,
      underlyingPrice: item.underlying_price || null,
      expiryMonth: item.expiry_month,
      time: item.time,
      premium: item.premium || null,
      volume: item.volume || null,
      strikePrice: item.strike || null,
      optionType: item.option_type,
      otm: item.otm || null,
      premiumPercent: item.premium_percentage || null,
      monthlyPercent: item.monthly_premium || null,
    }));

    res.json({
      success: true,
      data: transformedData,
      pagination: {
        total: totalCount,
        page,
        limit,
        totalPages: Math.ceil(totalCount / limit),
      },
    });
  } catch (error: any) {
    devError("Error fetching Covered Calls data:", error);
    prodError("Error fetching Covered Calls data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch Covered Calls data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getCoveredCallsStats = async (req: Request, res: Response) => {
  try {
    const underlying = req.query.underlying as string;
    const optionType = req.query.optionType as string;
    const minOtm = req.query.minOtm ? parseFloat(req.query.minOtm as string) : null;
    const maxOtm = req.query.maxOtm ? parseFloat(req.query.maxOtm as string) : null;
    const minPremium = req.query.minPremium ? parseFloat(req.query.minPremium as string) : null;
    const maxPremium = req.query.maxPremium ? parseFloat(req.query.maxPremium as string) : null;

    // Build filter conditions using Prisma.sql
    const filters: Prisma.Sql[] = [];
    filters.push(Prisma.sql`rn = 1`);

    if (underlying) {
      filters.push(Prisma.sql`underlying ILIKE ${`%${underlying}%`}`);
    }
    if (optionType) {
      filters.push(Prisma.sql`option_type = ${optionType}`);
    }
    if (minOtm !== null) {
      filters.push(Prisma.sql`otm >= ${minOtm}`);
    }
    if (maxOtm !== null) {
      filters.push(Prisma.sql`otm <= ${maxOtm}`);
    }
    if (minPremium !== null) {
      filters.push(Prisma.sql`monthly_premium >= ${minPremium}`);
    }
    if (maxPremium !== null) {
      filters.push(Prisma.sql`monthly_premium <= ${maxPremium}`);
    }

    const whereClause = filters.length > 0 ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}` : Prisma.empty;

    // Get total count with filters
    const countResult = await prisma.$queryRaw<
      Array<{ count: bigint; avg_premium: string; expiry_month: string[] }>
    >`
    WITH latest_tick_opt AS (
        SELECT DISTINCT ON ("instrumentId")
            "instrumentId", ltp, volume, time
        FROM periodic_market_data."ticksDataNSEOPT"
        WHERE time >= CURRENT_DATE - INTERVAL '3 days'
        ORDER BY "instrumentId", id DESC
    ),
    latest_tick_eq AS (
        SELECT DISTINCT ON ("instrumentId")
       		"instrumentId", ltp, time
 		FROM periodic_market_data."ticksDataNSEEQ"
        WHERE time >= CURRENT_DATE - INTERVAL '3 days'
        ORDER BY "instrumentId", id DESC
    ),
    strike_extraction AS (
        SELECT
            s.id,
            s.instrument_id,
            s.symbol,
            s.strike::numeric strike,
            s.option_type,
            s.expiry_month,
            s.expiry_date
        FROM market_data.symbols_list s
        WHERE s.segment = 'OPT'
        AND s.expiry_date >= CURRENT_DATE
        AND s.upstox_id is not null
    ),
    with_calcs AS (
        SELECT
            i.id as id,
            i.instrument_type AS underlying,
            se.expiry_month AS expiry_month,
            e.ltp::numeric AS underlying_price,
            TO_CHAR(o.time, 'yyyy-mm-dd HH12:MI AM') AS time,
            o.ltp::numeric AS premium,
            o.volume,
            se.strike,
            se.option_type,
            ROUND(((se.strike::numeric / e.ltp::numeric) - 1) * 100, 2) * -1 AS otm,
            ROUND((o.ltp::numeric / e.ltp::numeric) * 100, 2) AS premium_percentage,
            COALESCE(ROUND((((o.ltp::numeric / e.ltp::numeric) * 100) * 30)/NULLIF((se.expiry_date - date(o.time)), 0),2),0) AS monthly_premium,
            dense_rank() over (partition by i.instrument_type order by date(o.time) desc) rn
        FROM market_data.instrument_lists i
        JOIN strike_extraction se ON i.id = se.instrument_id
        JOIN latest_tick_opt o ON se.id = o."instrumentId"       
 		JOIN latest_tick_eq e ON e."instrumentId" = i.id
 	)
    SELECT COUNT(*) as count, 1 as avg_premium, json_agg(distinct trim(expiry_month)) expiry_month
    FROM with_calcs
    ${whereClause}
    `;

    const totalCount = Number(countResult[0]?.count || 0);
    const avg_premium = Number(countResult[0]?.avg_premium || 0.0);
    const expiry_month = Array.isArray(countResult[0]?.expiry_month)
      ? countResult[0]?.expiry_month
      : [];

    res.json({
      success: true,
      data: {
        total: totalCount,
        avg_premium,
        expiry_month,
      }
    });
  } catch (error: any) {
    devError("Error fetching Covered Calls stats:", error);
    prodError("Error fetching Covered Calls stats");
    res.status(500).json({
      success: false,
      error: "Failed to fetch Covered Calls stats",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

// Optional: Get covered calls data for a specific underlying symbol
export const getCoveredCallsByUnderlying = async (
  req: Request,
  res: Response
) => {
  try {
    const { underlying } = req.query;

    if (!underlying) {
      return res.status(400).json({
        success: false,
        error: "underlying query parameter is required",
      });
    }

    const coveredCallsData = await prisma.$queryRaw<
      Array<{
        underlying: string;
        underlying_price: string;
        option_symbol: string;
        time: string;
        premium: string;
        volume: string;
        strike: string;
        option_type: string;
      }>
    >`
      WITH latest_opt_ticks AS (
        SELECT
          sl.id AS symbol_id,
          sl.symbol,
          t.ltp,
          t.volume,
          ROW_NUMBER() OVER (PARTITION BY sl.id ORDER BY t.id DESC) AS rn
        FROM periodic_market_data."ticksDataNSEOPT" t
        INNER JOIN market_data.symbols_list sl ON t."instrumentId" = sl.id
        WHERE sl.segment = 'OPT' and sl.upstox_id is not null
      ),
      latest_eq_ticks AS (
        SELECT
          sl.instrument_id,
          sl.symbol,
          t.ltp,
          ROW_NUMBER() OVER (PARTITION BY sl.id ORDER BY t.id DESC) AS rn
        FROM periodic_market_data."ticksDataNSEEQ" t
        INNER JOIN market_data.symbols_list sl ON t."instrumentId" = sl.id
        WHERE sl.segment = 'EQ' and sl.upstox_id is not null
      )
      SELECT DISTINCT
        il.instrument_type as underlying,
        eq_tick.ltp as underlying_price,
        opt_tick.symbol as option_symbol,
        opt_tick.ltp as premium,
        opt_tick.volume,
        opt.strike,
        CAST(opt.strike AS FLOAT) as strike_float,
        opt.option_type
      FROM market_data.nse_options opt
      INNER JOIN market_data.instrument_lists il ON opt.underlying = il.id
      LEFT JOIN latest_opt_ticks opt_tick ON opt.symbol = opt_tick.symbol_id AND opt_tick.rn = 1
      LEFT JOIN latest_eq_ticks eq_tick ON opt.underlying = eq_tick.instrument_id AND eq_tick.rn = 1
      WHERE opt.expiry_date >= CURRENT_DATE
      AND il.instrument_type ILIKE ${`%${underlying}%`}
      AND opt_tick.ltp IS NOT NULL
      AND eq_tick.ltp IS NOT NULL
      ORDER BY il.instrument_type, strike_float, opt.option_type
    `;

    // Transform the data to proper format with type conversions
    const transformedData = coveredCallsData.map((item) => ({
      underlyingSymbol: item.underlying,
      underlyingPrice: item.underlying_price
        ? parseFloat(item.underlying_price)
        : null,
      optionSymbol: item.option_symbol,
      premium: item.premium ? parseFloat(item.premium) : null,
      volume: item.volume ? parseInt(item.volume as string) : null,
      strikePrice: item.strike ? parseFloat(item.strike) : null,
      optionType: item.option_type,
    }));

    res.json({
      success: true,
      data: transformedData,
      count: transformedData.length,
    });
  } catch (error: any) {
    devError("Error fetching Covered Calls data by underlying:", error);
    prodError("Error fetching Covered Calls data by underlying");
    res.status(500).json({
      success: false,
      error: "Failed to fetch Covered Calls data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

/**
 * Get symbols and expiry dates for a specific instrument (for filter dropdowns)
 */
export const getCoveredCallsSymbolsExpiry = async (
  req: Request,
  res: Response
) => {
  try {
    const { instrumentId } = req.params;
    const { option_type } = req.query;

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

    const filters: Prisma.Sql[] = [];
    filters.push(Prisma.sql`sl.instrument_id = ${numericId}`);
    filters.push(Prisma.sql`sl.expiry_date >= CURRENT_DATE`);
    filters.push(Prisma.sql`sl.upstox_id is not null`);
    filters.push(Prisma.sql`sl.segment = 'OPT'`);

    if (option_type && option_type !== "ALL") {
      filters.push(Prisma.sql`option_type = ${option_type as string}`);
    }

    const query = Prisma.sql`
      SELECT DISTINCT sl.symbol, sl.expiry_date, sl.strike, sl.upstox_id, TO_CHAR(sl.expiry_date, 'Month') expiry_month
      FROM market_data.symbols_list sl
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY sl.expiry_date, sl.symbol;
    `;

    const result = await prisma.$queryRaw<any[]>(query);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    devError("Error fetching symbols and expiry dates:", error);
    prodError("Error fetching symbols and expiry dates");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { error: error instanceof Error ? error.message : "Unknown error" }),
    });
  }
};

/**
 * Get filtered covered calls details for a specific instrument with pagination
 * Supports filtering by option type, expiry date, and symbol
 */
export const getFilteredCoveredCallsDetails = async (
  req: Request,
  res: Response
) => {
  try {
    const { instrumentId } = req.params;
    const {
      page = "1",
      limit = "360",
      optionType,
      expiryDate,
      symbol,
    } = req.query;

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

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.max(1, Math.min(500, parseInt(limit as string) || 360));
    const offset = (pageNum - 1) * limitNum;

    // Build filter conditions using Prisma.sql
    const filters: Prisma.Sql[] = [];

    if (optionType && optionType !== "ALL") {
      filters.push(Prisma.sql`option_type = ${optionType as string}`);
    }

    if (expiryDate) {
      filters.push(Prisma.sql`expiry_date = ${new Date(expiryDate as string)}`);
    }

    if (symbol) {
      filters.push(Prisma.sql`option_symbol ILIKE ${`%${symbol}%`}`);
    }

    const filterSql = filters.length > 0
      ? Prisma.sql`AND ${Prisma.join(filters, " AND ")}`
      : Prisma.empty;

    // Base query with all CTEs
    const baseQuery = Prisma.sql`
      WITH latest_tick_opt AS (
          SELECT DISTINCT ON ("instrumentId")
              op.id, "instrumentId", ltp, volume, time
          FROM periodic_market_data."ticksDataNSEOPT" op
          INNER JOIN market_data.symbols_list sl ON sl.id = op."instrumentId"
          WHERE sl.instrument_id = ${numericId} 
            AND sl.upstox_id is not null
            AND op.time >= CURRENT_DATE - INTERVAL '3 days'
          ORDER BY "instrumentId", op.id DESC
      ),
      latest_tick_eq AS (
          SELECT ltp
          FROM periodic_market_data."ticksDataNSEEQ"
          WHERE "instrumentId" = ${numericId}
            AND time >= CURRENT_DATE - INTERVAL '3 days'
          ORDER BY id DESC
          LIMIT 1
      ),
      strike_extraction AS (
          SELECT
              s.id,
              s.instrument_id,
              s.symbol,
              s.strike::numeric strike,
              option_type,
              s.expiry_date,
              s.upstox_id
          FROM market_data.symbols_list s
          WHERE s.instrument_id = ${numericId} 
            AND s.segment = 'OPT'
            AND s.upstox_id IS NOT NULL
      ),
      with_calcs AS (
          SELECT
              i.id AS id,
              i.instrument_type AS underlying,
              se.upstox_id AS underlying_upstox_id,
              se.symbol AS option_symbol,
              e.ltp::numeric AS underlying_price,
              TO_CHAR(o.time, 'DD Mon, YYYY HH12:MI AM') AS time,
              o.ltp::numeric AS premium,
              o.volume,
              se.strike,
              se.option_type,
              se.expiry_date,
              ROUND(((se.strike::numeric / e.ltp::numeric) - 1) * 100, 2) * -1 AS otm,
              ROUND((o.ltp::numeric / e.ltp::numeric) * 100, 2) AS premium_percentage,
              COALESCE(ROUND((((o.ltp::numeric / e.ltp::numeric) * 100) * 30)/NULLIF((se.expiry_date - date(o.time)), 0),2),0) AS monthly_premium
          FROM market_data.instrument_lists i
          JOIN strike_extraction se ON i.id = se.instrument_id
          JOIN latest_tick_opt o ON se.id = o."instrumentId"
          CROSS JOIN latest_tick_eq e
          WHERE i.id = ${numericId}
      )
    `;

    // Single pass: window functions compute totals/summary over every matching
    // row (pre-LIMIT), so we don't need a second unpaginated query just to count.
    const dataQuery = Prisma.sql`
      ${baseQuery},
      filtered AS (
        SELECT
            id,
            underlying,
            underlying_upstox_id,
            option_symbol,
            time,
            underlying_price,
            premium,
            volume,
            strike,
            option_type,
            otm,
            premium_percentage,
            monthly_premium,
            expiry_date
        FROM with_calcs
        WHERE 1=1 ${filterSql}
      )
      SELECT
          *,
          COUNT(*) OVER() AS full_count,
          COUNT(*) FILTER (WHERE option_type = 'CE') OVER() AS ce_count,
          COUNT(*) FILTER (WHERE option_type = 'PE') OVER() AS pe_count,
          (SUM(COALESCE(premium_percentage, 0)) OVER() / NULLIF(COUNT(*) OVER(), 0)) AS avg_premium_percentage
      FROM filtered
      ORDER BY underlying, time DESC, strike
      LIMIT ${limitNum}
      OFFSET ${offset}
    `;

    const rawData = await prisma.$queryRaw<any[]>(dataQuery);

    const totalCount = rawData.length > 0 ? Number(rawData[0].full_count) : 0;
    const totalPages = Math.ceil(totalCount / limitNum);

    const ceCount = rawData.length > 0 ? Number(rawData[0].ce_count) : 0;
    const peCount = rawData.length > 0 ? Number(rawData[0].pe_count) : 0;
    const avgPremiumPercentage = rawData.length > 0 ? Number(rawData[0].avg_premium_percentage) || 0 : 0;

    // Strip the per-row window-function columns (full_count/ce_count/pe_count/
    // avg_premium_percentage) — they're the same on every row, already surfaced
    // in `summary` below, and weren't part of the original response shape.
    const data = rawData.map(({ full_count, ce_count, pe_count, avg_premium_percentage, ...row }) => row);

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
        ceCount,
        peCount,
        totalCount,
        avgPremiumPercentage: Math.round(avgPremiumPercentage * 100) / 100,
      },
    });
  } catch (error) {
    devError("Error fetching filtered covered calls details:", error);
    prodError("Error fetching filtered covered calls details");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { error: error instanceof Error ? error.message : "Unknown error" }),
    });
  }
};

/**
 * Latest options ticks by instrument (historical fallback for Covered Calls Details)
 */
export const getLatestOptionsTicksByInstrument = async (
  req: Request,
  res: Response
) => {
  try {
    const { instrumentId } = req.params;
    const { expiryDate } = req.query as { expiryDate?: string };
    if (!instrumentId) {
      return res
        .status(400)
        .json({ success: false, message: "instrumentId is required" });
    }

    const numericId = Number(instrumentId);
    if (Number.isNaN(numericId)) {
      return res.status(400).json({
        success: false,
        message: "instrumentId must be a valid number",
      });
    }

    // Build expiry filter securely
    const expiryFilter = expiryDate
      ? Prisma.sql`AND sl.expiry_date = ${new Date(expiryDate.split("T")[0])}`
      : Prisma.sql`AND sl.expiry_date >= NOW()`;

    const query = Prisma.sql`
      WITH latest_opt_ticks AS (
        SELECT
          tdn.ltp,
          tdn.oi,
          tdn.volume,
          tdn.bid,
          tdn.bidqty,
          tdn.ask,
          tdn.askqty,
          sl.symbol,
          sl.upstox_id,
          sl.strike,
          ROW_NUMBER() OVER (
            PARTITION BY tdn."instrumentId"
            ORDER BY tdn."time" DESC
          ) AS rn,
          tdn."time" AS time,
          DATE(tdn."time") AS date,
          sl.expiry_date
        FROM periodic_market_data."ticksDataNSEOPT" tdn
        INNER JOIN market_data.symbols_list sl
          ON tdn."instrumentId" = sl.id
        INNER JOIN market_data.instrument_lists il
          ON sl.instrument_id = il.id
        WHERE il.id = ${numericId} and sl.upstox_id is not null
          ${expiryFilter}
      )
      SELECT *
      FROM latest_opt_ticks
      WHERE rn = 1
      ORDER BY strike;
    `;

    const result = await prisma.$queryRaw<any[]>(query);
    // Convert any BigInt fields to strings to avoid JSON serialization errors
    const safe = Array.isArray(result)
      ? result.map((r) =>
        JSON.parse(
          JSON.stringify(r, (_key, value) =>
            typeof value === "bigint" ? value.toString() : value
          )
        )
      )
      : result;
    return res.status(200).json({ success: true, data: safe });
  } catch (error: any) {
    devError("Error fetching latest options ticks:", error);
    prodError("Error fetching latest options ticks");
    return res.status(500).json({ success: false, message: process.env.NODE_ENV !== "production" ? error.message : "Internal server error" });
  }
};

/**
 * Daily options trend for a covered-calls instrument
 * Filters: expiry (YYYY-MM), optionType (CE/PE), strike, page
 */
export const getCoveredCallsTrendDaily = async (
  req: Request,
  res: Response
) => {
  try {
    const { instrumentId } = req.params;
    const {
      page = "1",
      optionType,
      minOtm,
      maxOtm,
      minPremium,
      maxPremium,
      startDate,
      endDate,
      expiryMonth
    } = req.query as {
      page?: string;
      optionType?: string;
      minOtm?: string;
      maxOtm?: string;
      minPremium?: string;
      maxPremium?: string;
      startDate?: string;
      endDate?: string;
      expiryMonth?: string;
    };

    if (!instrumentId) {
      return res
        .status(400)
        .json({ success: false, message: "instrumentId is required" });
    }

    const numericId = Number(instrumentId);
    if (Number.isNaN(numericId)) {
      return res.status(400).json({
        success: false,
        message: "instrumentId must be a valid number",
      });
    }

    const pageNum = Math.max(1, parseInt(page || "1", 10) || 1);
    const limitNum = 360;
    const offset = (pageNum - 1) * limitNum;

    const filters: Prisma.Sql[] = [];
    filters.push(Prisma.sql`no2.underlying = ${numericId}`);

    if (optionType && optionType !== "ALL") {
      filters.push(Prisma.sql`no2.option_type = ${optionType}`);
    }

    if (minOtm) {
      const v = Number(minOtm);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`ROUND(((no2.strike::numeric / ne."close"::numeric) - 1) * 100, 2) * -1 >= ${v}`);
      }
    }

    if (maxOtm) {
      const v = Number(maxOtm);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`ROUND(((no2.strike::numeric / ne."close"::numeric) - 1) * 100, 2) * -1 <= ${v}`);
      }
    }

    if (minPremium) {
      const v = Number(minPremium);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`COALESCE(ROUND(((no2."close"::numeric / ne."close"::numeric) * 100 * 30)/NULLIF((no2.expiry_date - ne."date"), 0),2),0) >= ${v}`);
      }
    }

    if (maxPremium) {
      const v = Number(maxPremium);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`COALESCE(ROUND(((no2."close"::numeric / ne."close"::numeric) * 100 * 30)/NULLIF((no2.expiry_date - ne."date"), 0),2),0) <= ${v}`);
      }
    }

    if (startDate) {
      filters.push(Prisma.sql`no2."date" >= ${new Date(startDate)}`);
    }

    if (endDate) {
      filters.push(Prisma.sql`no2."date" <= ${new Date(endDate)}`);
    }

    if (expiryMonth && expiryMonth !== "ALL") {
      filters.push(Prisma.sql`trim(no2.expiry_month) = ${expiryMonth.trim()}`);
    }

    const whereSql = filters.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`
      : Prisma.empty;

    const dataQuery = Prisma.sql`
      SELECT 
        il.instrument_type AS underlying,
        TO_CHAR(ne."date", 'yyyy-mm-dd') AS time, 
        ne."close"::numeric AS underlying_price, 
        no2.strike,
        no2.expiry_month, 
        no2.option_type, 
        no2."close"::numeric AS premium,
        no2.volume,
        ROUND(((no2.strike::numeric / ne."close"::numeric) - 1) * 100, 2) * -1 AS otm,
        ROUND((no2."close"::numeric / ne."close"::numeric) * 100, 2) AS premium_percentage,
        COALESCE(ROUND(((no2."close"::numeric / ne."close"::numeric) * 100 * 30)/NULLIF((no2.expiry_date - ne."date"), 0),2),0) AS monthly_percentage,
        COUNT(*) OVER() AS full_count
      FROM market_data.nse_options no2
      INNER JOIN market_data.instrument_lists il 
        ON no2.underlying = il.id  
      INNER JOIN market_data.nse_equity ne 
        ON ne.symbol_id = il.id 
        AND no2."date" = ne."date"
      ${whereSql}
      ORDER BY ne."date" DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const metaQuery = Prisma.sql`
      SELECT json_agg(distinct no2.expiry_month) AS expiry_month
      FROM market_data.nse_options no2
      WHERE no2.underlying = ${numericId}
    `;

    const [rows, metaResult] = await Promise.all([
      prisma.$queryRaw<any[]>(dataQuery),
      prisma.$queryRaw<any[]>(metaQuery),
    ]);

    const totalCount = rows.length > 0 ? Number(rows[0].full_count) : 0;
    const totalPages = Math.ceil(totalCount / limitNum) || 1;

    return res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        expiry_month: metaResult?.[0]?.expiry_month || [],
        totalPages,
        hasMore: pageNum < totalPages,
      },
    });
  } catch (error: any) {
    devError("Error fetching covered calls daily trend:", error);
    prodError("Error fetching covered calls daily trend");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { error: error.message }),
    });
  }
};

/**
 * Hourly options trend for a covered-calls instrument
 * Filters: expiry (YYYY-MM), optionType (CE/PE), strike, page
 */
export const getCoveredCallsTrendHourly = async (
  req: Request,
  res: Response
) => {
  try {
    const { instrumentId } = req.params;
    const {
      page = "1",
      optionType,
      minOtm,
      maxOtm,
      minPremium,
      maxPremium,
      startDate,
      endDate,
      expiryMonth
    } = req.query as {
      page?: string;
      optionType?: string;
      minOtm?: string;
      maxOtm?: string;
      minPremium?: string;
      maxPremium?: string;
      startDate?: string;
      endDate?: string;
      expiryMonth?: string;
    };

    if (!instrumentId) {
      return res
        .status(400)
        .json({ success: false, message: "instrumentId is required" });
    }

    const numericId = Number(instrumentId);
    if (Number.isNaN(numericId)) {
      return res.status(400).json({
        success: false,
        message: "instrumentId must be a valid number",
      });
    }

    const pageNum = Math.max(1, parseInt(page || "1", 10) || 1);
    const limitNum = 360;
    const offset = (pageNum - 1) * limitNum;

    const filters: Prisma.Sql[] = [];
    filters.push(Prisma.sql`id = ${numericId}`);

    if (optionType && optionType !== "ALL") {
      filters.push(Prisma.sql`option_type = ${optionType}`);
    }

    if (minOtm) {
      const v = Number(minOtm);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`otm >= ${v}`);
      }
    }

    if (maxOtm) {
      const v = Number(maxOtm);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`otm <= ${v}`);
      }
    }

    if (minPremium) {
      const v = Number(minPremium);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`monthly_premium >= ${v}`);
      }
    }

    if (maxPremium) {
      const v = Number(maxPremium);
      if (!Number.isNaN(v)) {
        filters.push(Prisma.sql`monthly_premium <= ${v}`);
      }
    }

    if (startDate) {
      filters.push(Prisma.sql`to_timestamp(time, 'yyyy-mm-dd HH12:MI AM')::date >= ${new Date(startDate)}`);
    }

    if (endDate) {
      filters.push(Prisma.sql`to_timestamp(time, 'yyyy-mm-dd HH12:MI AM')::date <= ${new Date(endDate)}`);
    }

    if (expiryMonth && expiryMonth !== "ALL") {
      filters.push(Prisma.sql`trim(expiry_month) = ${expiryMonth.trim()}`);
    }

    const filterSql = filters.length > 0
      ? Prisma.sql`WHERE ${Prisma.join(filters, " AND ")}`
      : Prisma.empty;

    const baseQuery = Prisma.sql`
      WITH latest_tick_opt AS (
          SELECT DISTINCT ON ("instrumentId", time_bucket)
              op.id,
              op."instrumentId",
              op.ltp,
              op.volume,
              op.time,
              date_trunc('hour', op.time) + floor(EXTRACT(minute FROM op.time)::int / 5) * interval '5 minutes' as time_bucket
          FROM periodic_market_data."ticksDataNSEOPT" op
          INNER JOIN market_data.symbols_list sl ON sl.id = op."instrumentId"
          WHERE sl.instrument_id = ${numericId} 
            AND sl.upstox_id is not null
            AND op.time >= CURRENT_DATE - INTERVAL '7 days'
          ORDER BY op."instrumentId", time_bucket, op.id DESC
      ),
      latest_tick_eq AS (
        SELECT DISTINCT ON (time_bucket)
       		"instrumentId", ltp, time, time_bucket
 		FROM periodic_market_data."ticksDataNSEEQ"
        WHERE "instrumentId" = ${numericId}
          AND time >= CURRENT_DATE - INTERVAL '7 days'
        ORDER BY time_bucket, time DESC
    ),
    strike_extraction AS (
        SELECT
            s.id,
            s.instrument_id,
            s.symbol,
            s.strike::numeric strike,
            s.option_type,
            s.expiry_month,
            s.expiry_date
        FROM market_data.symbols_list s
        WHERE s.instrument_id = ${numericId}
          AND s.segment = 'OPT'
          AND s.expiry_date >= CURRENT_DATE
    ),
      with_calcs AS (
          SELECT
              i.id AS id,
              i.instrument_type AS underlying,
              se.expiry_month AS expiry_month,
              se.expiry_date AS expiry_date,
              e.ltp::numeric AS underlying_price,
              TO_CHAR(o.time_bucket, 'yyyy-mm-dd HH12:MI AM') AS time,
              o.ltp::numeric AS premium,
              o.volume,
              se.strike,
              se.option_type,
              ROUND(((se.strike::numeric / e.ltp::numeric) - 1) * 100, 2) * -1 AS otm,
              ROUND((o.ltp::numeric / e.ltp::numeric) * 100, 2) AS premium_percentage,
              COALESCE(ROUND((((o.ltp::numeric / e.ltp::numeric) * 100) * 30)/NULLIF((se.expiry_date - date(o.time)), 0),2),0) AS monthly_premium
          FROM market_data.instrument_lists i
          JOIN strike_extraction se ON i.id = se.instrument_id
          JOIN latest_tick_opt o ON se.id = o."instrumentId"
          JOIN latest_tick_eq e ON e."instrumentId" = i.id AND e.time_bucket = o.time_bucket
      )
    `;

    // Single pass: COUNT(*) OVER() computes the full match count alongside the
    // paginated rows, so we don't need a second unpaginated query just to count.
    const dataQuery = Prisma.sql`
      ${baseQuery}
      SELECT
          id,
          underlying,
          expiry_month,
          time,
          underlying_price,
          premium,
          volume,
          strike,
          option_type,
          otm,
          premium_percentage,
          monthly_premium,
          expiry_date,
          COUNT(*) OVER() AS full_count
      FROM with_calcs
      ${filterSql}
      ORDER BY time DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const metaQuery = Prisma.sql`
      SELECT json_agg(distinct expiry_month) AS expiry_month
      FROM market_data.nse_options
      WHERE underlying = ${numericId}
    `;

    const [rowsRaw, metaResult] = await Promise.all([
      prisma.$queryRaw<any[]>(dataQuery),
      prisma.$queryRaw<any[]>(metaQuery),
    ]);

    const totalCount = rowsRaw.length > 0 ? Number(rowsRaw[0].full_count) : 0;
    const totalPages = Math.ceil(totalCount / limitNum) || 1;
    const expiry_month = metaResult?.[0]?.expiry_month || [];

    // Drop expiry_date from response to match daily trend shape
    const rows = rowsRaw.map((r) => ({
      underlying: r.underlying,
      expiry_month: r.expiry_month,
      time: r.time,
      underlying_price: r.underlying_price,
      premium: r.premium,
      volume: r.volume,
      strike: r.strike,
      option_type: r.option_type,
      otm: r.otm,
      premium_percentage: r.premium_percentage,
      monthly_percentage: r.monthly_premium,
    }));

    return res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        totalPages,
        expiry_month,
        hasMore: pageNum < totalPages,
      },
    });
  } catch (error: any) {
    devError("Error fetching covered calls hourly trend:", error);
    prodError("Error fetching covered calls hourly trend");
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      ...(process.env.NODE_ENV !== "production" && { error: error.message }),
    });
  }
};
