import { Request, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();

export const getCoveredCallsData = async (req: Request, res: Response) => {
  try {
    // Get pagination and filter parameters
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 100;
    const offset = (page - 1) * limit;
    const underlying = req.query.underlying as string;
    const optionType = req.query.optionType as string;
    const minOtm = req.query.minOtm
      ? parseFloat(req.query.minOtm as string)
      : null;
    const maxOtm = req.query.maxOtm
      ? parseFloat(req.query.maxOtm as string)
      : null;
    const minPremium = req.query.minPremium
      ? parseFloat(req.query.minPremium as string)
      : null;
    const maxPremium = req.query.maxPremium
      ? parseFloat(req.query.maxPremium as string)
      : null;
    const expiryMonth = req.query.expiryMonth as string;

    // Build filter conditions
    let filterCondition = "";
    if (underlying) {
      filterCondition += ` AND underlying ILIKE '%${underlying}%'`;
    }
    if (optionType) {
      filterCondition += ` AND option_type = '${optionType}'`;
    }
    if (minOtm !== null) {
      filterCondition += ` AND otm >= ${minOtm}`;
    }
    if (maxOtm !== null) {
      filterCondition += ` AND otm <= ${maxOtm}`;
    }
    if (minPremium !== null) {
      filterCondition += ` AND monthly_premium >= ${minPremium}`;
    }
    if (maxPremium !== null) {
      filterCondition += ` AND monthly_premium <= ${maxPremium}`;
    }

    // Get total count with filters
    const countResult = await prisma.$queryRaw<
      Array<{ count: bigint; avg_premium: string; expiry_month: string[] }>
    >`
    WITH latest_tick_opt AS (
        SELECT DISTINCT ON ("instrumentId")
            "instrumentId", ltp, volume, time
        FROM periodic_market_data."ticksDataNSEOPT"
        ORDER BY "instrumentId", id DESC
    ),
    latest_tick_eq AS (
        SELECT DISTINCT ON ("instrumentId", time_bucket)
       		"instrumentId", ltp, time, time_bucket
		FROM (
    		SELECT * FROM periodic_market_data."ticksDataNSEEQ"
		) t ORDER BY "instrumentId", time_bucket, time DESC
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
		JOIN LATERAL (
        SELECT * FROM latest_tick_eq e
    		WHERE e."instrumentId" = i.id 
        AND e.time_bucket IN (
              date_trunc('hour', o.time) + floor(EXTRACT(minute FROM o.time)::int / 5) * interval '5 minutes',
              date_trunc('hour', o.time) + (floor(EXTRACT(minute FROM o.time)::int / 5) + 4) * interval '5 minutes'
          )
        ORDER BY ABS(EXTRACT(EPOCH FROM (e.time - o.time)))
    		LIMIT 1
		) e ON true
 	)
    SELECT COUNT(*) as count, 1 as avg_premium, json_agg(distinct expiry_month) expiry_month
    FROM with_calcs
    WHERE 1=1 ${Prisma.raw(filterCondition)}
    `;

    const totalCount = Number(countResult[0]?.count || 0);
    const avg_premium = Number(countResult[0]?.avg_premium || 0.0);
    const expiry_month = Array.isArray(countResult[0]?.expiry_month)
      ? countResult[0]?.expiry_month
      : [];

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
      }>
    >`WITH latest_tick_opt AS (
        SELECT DISTINCT ON ("instrumentId")
            "instrumentId", ltp, volume, time
        FROM periodic_market_data."ticksDataNSEOPT"
        ORDER BY "instrumentId", id DESC
    ),
    latest_tick_eq AS (
        SELECT DISTINCT ON ("instrumentId", time_bucket)
       		"instrumentId", ltp, time, time_bucket
		FROM (
    		SELECT * FROM periodic_market_data."ticksDataNSEEQ"
		) t ORDER BY "instrumentId", time_bucket, time DESC
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
		JOIN LATERAL (
        SELECT * FROM latest_tick_eq e
    		WHERE e."instrumentId" = i.id 
        AND e.time_bucket IN (
              date_trunc('hour', o.time) + floor(EXTRACT(minute FROM o.time)::int / 5) * interval '5 minutes',
              date_trunc('hour', o.time) + (floor(EXTRACT(minute FROM o.time)::int / 5) + 4) * interval '5 minutes'
          )
        ORDER BY ABS(EXTRACT(EPOCH FROM (e.time - o.time)))
    		LIMIT 1
		) e ON true
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
        monthly_premium
    FROM with_calcs
    WHERE rn=1 ${Prisma.raw(filterCondition)} ${
      Prisma.raw(expiryMonth !== null &&
      expiryMonth !== undefined &&
      expiryMonth !== "" &&
      expiryMonth !== "ALL"
        ? ` AND trim(expiry_month) = '${expiryMonth}'`
        : " AND 1 = 1")
    }
    ORDER BY underlying, strike
    LIMIT ${limit}
    OFFSET ${offset}
    `;

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
      count: transformedData.length,
      avg_premium,
      expiry_month,
      total: totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
      hasMore: page < Math.ceil(totalCount / limit),
    });
  } catch (error: any) {
    console.error("Error fetching Covered Calls data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch Covered Calls data",
      message: error.message,
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
          sl.symbol,
          t.ltp,
          t.volume,
          ROW_NUMBER() OVER (PARTITION BY sl.id ORDER BY t.id DESC) AS rn
        FROM periodic_market_data."ticksDataNSEOPT" t
        INNER JOIN market_data.symbols_list sl ON t."instrumentId" = sl.id
        WHERE sl.segment = 'OPT'
      ),
      latest_eq_ticks AS (
        SELECT
          sl.symbol,
          t.ltp,
          ROW_NUMBER() OVER (PARTITION BY sl.id ORDER BY t.id DESC) AS rn
        FROM periodic_market_data."ticksDataNSEEQ" t
        INNER JOIN market_data.symbols_list sl ON t."instrumentId" = sl.id
        WHERE sl.segment = 'EQ'
      )
      SELECT DISTINCT
        opt.underlying,
        eq_tick.ltp as underlying_price,
        opt.symbol as option_symbol,
        opt_tick.ltp as premium,
        opt_tick.volume,
        opt.strike,
        opt.option_type
      FROM market_data.nse_options opt
      LEFT JOIN latest_opt_ticks opt_tick ON opt.symbol = opt_tick.symbol AND opt_tick.rn = 1
      LEFT JOIN latest_eq_ticks eq_tick ON opt.underlying = eq_tick.symbol AND eq_tick.rn = 1
      WHERE opt.expiry_date >= CURRENT_DATE
      AND opt.underlying ILIKE ${`%${underlying}%` as any}
      AND opt_tick.ltp IS NOT NULL
      AND eq_tick.ltp IS NOT NULL
      ORDER BY opt.underlying, CAST(opt.strike AS FLOAT), opt.option_type
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
    console.error("Error fetching Covered Calls data by underlying:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch Covered Calls data",
      message: error.message,
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

    const query = `
      SELECT DISTINCT sl.symbol, sl.expiry_date, sl.strike, TO_CHAR(sl.expiry_date, 'Month') expiry_month
      FROM market_data.symbols_list sl
      WHERE sl.instrument_id = ${instrumentId}
        AND sl.expiry_date >= CURRENT_DATE
        AND sl.segment = 'OPT' ${
          option_type && option_type !== "ALL"
            ? `AND option_type = '${option_type}'`
            : "AND 1=1"
        }
      ORDER BY sl.expiry_date, sl.symbol;
    `;

    const result = await prisma.$queryRawUnsafe(query);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (error) {
    console.error("Error fetching symbols and expiry dates:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
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

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    // Build filter conditions
    let filterConditions = "";

    if (optionType && optionType !== "ALL") {
      filterConditions += ` AND option_type = '${optionType}'`;
    }

    if (expiryDate) {
      filterConditions += ` AND expiry_date = '${expiryDate}'`;
    }

    if (symbol) {
      filterConditions += ` AND option_symbol ILIKE '%${symbol}%'`;
    }

    // Base query with all CTEs
    const baseQuery = `
      WITH latest_tick_opt AS (
          SELECT DISTINCT
              op.id, "instrumentId", ltp, volume, time
          FROM periodic_market_data."ticksDataNSEOPT" op
          INNER JOIN market_data.symbols_list sl ON sl.id = op."instrumentId"
          WHERE sl.instrument_id = ${instrumentId}
          ORDER BY "instrumentId", op.id DESC
      ),
      latest_tick_eq AS (
          SELECT DISTINCT ON ("instrumentId")
              "instrumentId", ltp
          FROM periodic_market_data."ticksDataNSEEQ"
          ORDER BY "instrumentId", id DESC
      ),
      strike_extraction AS (
          SELECT
              s.id,
              s.instrument_id,
              s.symbol,
              s.strike::numeric strike,
              option_type,
              s.expiry_date
          FROM market_data.symbols_list s
          WHERE s.segment = 'OPT'
      ),
      with_calcs AS (
          SELECT
              i.id AS id,
              i.instrument_type AS underlying,
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
          JOIN latest_tick_eq e ON i.id = e."instrumentId"
      )
      SELECT
          id,
          underlying,
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
      WHERE 1=1 ${filterConditions}
    `;

    // Count query
    const countQuery = baseQuery;

    // Data query with pagination
    const dataQuery =
      baseQuery +
      `
      ORDER BY underlying, time DESC, strike
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

    // Calculate summary statistics
    const ceCount = Array.isArray(countResult)
      ? countResult.filter((row: any) => row.option_type === "CE").length
      : 0;

    const peCount = Array.isArray(countResult)
      ? countResult.filter((row: any) => row.option_type === "PE").length
      : 0;

    const avgPremiumPercentage =
      Array.isArray(countResult) && countResult.length > 0
        ? countResult.reduce(
            (sum: number, row: any) =>
              sum + (parseFloat(row.premium_percentage) || 0),
            0
          ) / countResult.length
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
        ceCount,
        peCount,
        totalCount,
        avgPremiumPercentage: Math.round(avgPremiumPercentage * 100) / 100,
      },
    });
  } catch (error) {
    console.error("Error fetching filtered covered calls details:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error instanceof Error ? error.message : "Unknown error",
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

    // Build expiry filter: either specific expiry (from UI) or default to nearest/future
    let expiryFilter = "AND sl.expiry_date >= NOW()";
    if (expiryDate) {
      // Basic safeguarding – keep only date-like characters to avoid SQL injection
      const safeExpiry = expiryDate.split("T")[0];
      if (safeExpiry) {
        expiryFilter = `AND sl.expiry_date = '${safeExpiry}'`;
      }
    }

    const query = `
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
        WHERE il.id = ${instrumentId}
          ${expiryFilter}
      )
      SELECT *
      FROM latest_opt_ticks
      WHERE rn = 1
      ORDER BY strike;
    `;

    const result = await prisma.$queryRawUnsafe(query);
    // Convert any BigInt fields to strings to avoid JSON serialization errors
    const safe = Array.isArray(result)
      ? (result as any[]).map((r) =>
          JSON.parse(
            JSON.stringify(r, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value
            )
          )
        )
      : result;
    return res.status(200).json({ success: true, data: safe });
  } catch (error: any) {
    console.error("Error fetching latest options ticks:", error);
    return res.status(500).json({ success: false, message: error.message });
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
      expiryMonth? : string;
    };

    if (!instrumentId) {
      return res
        .status(400)
        .json({ success: false, message: "instrumentId is required" });
    }

    const pageNum = parseInt(page || "1", 10) || 1;
    const limitNum = 360;
    const offset = (pageNum - 1) * limitNum;

    let filterConditions = "";

    if (optionType && optionType !== "ALL") {
      filterConditions += ` AND no2.option_type = '${optionType}'`;
    }

    if (minOtm) {
      const v = Number(minOtm);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND ROUND(((no2.strike::numeric / ne."close"::numeric) - 1) * 100, 2) * -1 >= ${v}`;
      }
    }

    if (maxOtm) {
      const v = Number(maxOtm);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND ROUND(((no2.strike::numeric / ne."close"::numeric) - 1) * 100, 2) * -1 <= ${v}`;
      }
    }

    if (minPremium) {
      const v = Number(minPremium);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND COALESCE(ROUND(((no2."close"::numeric / ne."close"::numeric) * 100 * 30)/NULLIF((no2.expiry_date - ne."date"), 0),2),0) >= ${v}`;
      }
    }

    if (maxPremium) {
      const v = Number(maxPremium);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND COALESCE(ROUND(((no2."close"::numeric / ne."close"::numeric) * 100 * 30)/NULLIF((no2.expiry_date - ne."date"), 0),2),0) <= ${v}`;
      }
    }

    if (startDate) {
      filterConditions += ` AND no2."date" >= '${startDate}'::date`;
    }

    if (endDate) {
      filterConditions += ` AND no2."date" <= '${endDate}'::date`;
    }

    const dataQuery = `
      SELECT 
        ne.symbol AS underlying, 
        TO_CHAR(ne."date", 'yyyy-mm-dd') AS time, 
        ne."close"::numeric AS underlying_price, 
        no2.strike,
        no2.expiry_month, 
        no2.option_type, 
        no2."close"::numeric AS premium,
        no2.volume,
        ROUND(((no2.strike::numeric / ne."close"::numeric) - 1) * 100, 2) * -1 AS otm,
        ROUND((no2."close"::numeric / ne."close"::numeric) * 100, 2) AS premium_percentage,
        COALESCE(ROUND(((no2."close"::numeric / ne."close"::numeric) * 100 * 30)/NULLIF((no2.expiry_date - ne."date"), 0),2),0) AS monthly_percentage
      FROM market_data.nse_options no2
      INNER JOIN market_data.instrument_lists il 
        ON no2.underlying = il.id  
      INNER JOIN market_data.nse_equity ne 
        ON ne.symbol = il.instrument_type 
        AND no2."date" = ne."date"
      WHERE no2.underlying = ${instrumentId}
      ${filterConditions} ${expiryMonth !== null &&
      expiryMonth !== undefined &&
      expiryMonth !== "" &&
      expiryMonth !== "ALL"
        ? ` AND trim(no2.expiry_month) = '${expiryMonth.trim()}'`
        : " AND 1 = 1"}
      ORDER BY ne."date" DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const countQuery = `
      SELECT 
        count(*) as count, json_agg(distinct no2.expiry_month) AS expiry_month
      FROM market_data.nse_options no2
      INNER JOIN market_data.instrument_lists il 
        ON no2.underlying = il.id  
      INNER JOIN market_data.nse_equity ne 
        ON ne.symbol = il.instrument_type 
        AND no2."date" = ne."date"
      WHERE no2.underlying = ${instrumentId}
      ${filterConditions}
    `;

    const [rows, countResult] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(dataQuery),
      prisma.$queryRawUnsafe<Array<{ count: bigint, expiry_month: string[]}>>(countQuery),
    ]);

    const totalCount = Number(countResult?.[0]?.count || 0);
    const totalPages = Math.ceil(totalCount / limitNum) || 1;

    return res.status(200).json({
      success: true,
      data: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalCount,
        expiry_month: countResult?.[0]?.expiry_month,
        totalPages,
        hasMore: pageNum < totalPages,
      },
    });
  } catch (error: any) {
    console.error("Error fetching covered calls daily trend:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
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

    const pageNum = parseInt(page || "1", 10) || 1;
    const limitNum = 360;
    const offset = (pageNum - 1) * limitNum;

    let filterConditions = "";

    if (optionType && optionType !== "ALL") {
      filterConditions += ` AND option_type = '${optionType}'`;
    }

    if (minOtm) {
      const v = Number(minOtm);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND otm >= ${v}`;
      }
    }

    if (maxOtm) {
      const v = Number(maxOtm);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND otm <= ${v}`;
      }
    }

    if (minPremium) {
      const v = Number(minPremium);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND monthly_premium >= ${v}`;
      }
    }

    if (maxPremium) {
      const v = Number(maxPremium);
      if (!Number.isNaN(v)) {
        filterConditions += ` AND monthly_premium <= ${v}`;
      }
    }

    if (startDate) {
      filterConditions += ` AND to_timestamp(time, 'yyyy-mm-dd HH12:MI AM')::date >= '${startDate}'::date`;
    }

    if (endDate) {
      filterConditions += ` AND to_timestamp(time, 'yyyy-mm-dd HH12:MI AM')::date <= '${endDate}'::date`;
    }

    const dataQuery = `
      WITH latest_tick_opt AS (
          SELECT DISTINCT
              op.id,
              op."instrumentId",
              op.ltp,
              op.volume,
              op.time
          FROM periodic_market_data."ticksDataNSEOPT" op
          INNER JOIN market_data.symbols_list sl ON sl.id = op."instrumentId"
          WHERE sl.instrument_id = ${instrumentId}
          ORDER BY op."instrumentId", op.id DESC
      ),
      latest_tick_eq AS (
        SELECT DISTINCT ON ("instrumentId", time_bucket)
       		"instrumentId", ltp, time, time_bucket
		FROM (
    		SELECT * FROM periodic_market_data."ticksDataNSEEQ"
		) t ORDER BY "instrumentId", time_bucket, time DESC
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
    ),
      with_calcs AS (
          SELECT
              i.id AS id,
              i.instrument_type AS underlying,
              se.expiry_month AS expiry_month,
              se.expiry_date AS expiry_date,
              e.ltp::numeric AS underlying_price,
              TO_CHAR(o.time, 'yyyy-mm-dd HH12:MI AM') AS time,
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
          JOIN LATERAL (
              SELECT *
              FROM latest_tick_eq e
              WHERE e."instrumentId" = i.id
              AND e.time_bucket IN (
                  date_trunc('hour', o.time) + floor(EXTRACT(minute FROM o.time)::int / 5) * interval '5 minutes',
                  date_trunc('hour', o.time) + (floor(EXTRACT(minute FROM o.time)::int / 5) + 4) * interval '5 minutes'
              )
              ORDER BY ABS(EXTRACT(EPOCH FROM (e.time - o.time)))
              LIMIT 1
          ) e ON true
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
          expiry_date
      FROM with_calcs
      WHERE id = ${instrumentId}
      ${filterConditions} ${expiryMonth !== null &&
      expiryMonth !== undefined &&
      expiryMonth !== "" &&
      expiryMonth !== "ALL"
        ? ` AND trim(expiry_month) = '${expiryMonth.trim()}'`
        : " AND 1 = 1"}
      ORDER BY time DESC
      LIMIT ${limitNum} OFFSET ${offset}
    `;

    const countQuery = `
      WITH latest_tick_opt AS (
          SELECT DISTINCT
              op.id,
              op."instrumentId",
              op.ltp,
              op.volume,
              op.time
          FROM periodic_market_data."ticksDataNSEOPT" op
          INNER JOIN market_data.symbols_list sl ON sl.id = op."instrumentId"
          WHERE sl.instrument_id = ${instrumentId}
          ORDER BY op."instrumentId", op.id DESC
      ),
      latest_tick_eq AS (
        SELECT DISTINCT ON ("instrumentId", time_bucket)
       		"instrumentId", ltp, time, time_bucket
		FROM (
    		SELECT * FROM periodic_market_data."ticksDataNSEEQ"
		) t ORDER BY "instrumentId", time_bucket, time DESC
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
    ),
      with_calcs AS (
          SELECT
              i.id AS id,
              i.instrument_type AS underlying,
              se.expiry_month AS expiry_month,
              se.expiry_date AS expiry_date,
              e.ltp::numeric AS underlying_price,
              TO_CHAR(o.time, 'yyyy-mm-dd HH12:MI AM') AS time,
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
          JOIN LATERAL (
              SELECT *
              FROM latest_tick_eq e
              WHERE e."instrumentId" = i.id
              AND e.time_bucket IN (
                  date_trunc('hour', o.time) + floor(EXTRACT(minute FROM o.time)::int / 5) * interval '5 minutes',
                  date_trunc('hour', o.time) + (floor(EXTRACT(minute FROM o.time)::int / 5) + 4) * interval '5 minutes'
              )
              ORDER BY ABS(EXTRACT(EPOCH FROM (e.time - o.time)))
              LIMIT 1
          ) e ON true
      )
      SELECT
          count(*), json_agg(distinct expiry_month) expiry_month
      FROM with_calcs
      WHERE id = ${instrumentId}
      ${filterConditions}
    `;

    const [rowsRaw, countResult] = await Promise.all([
      prisma.$queryRawUnsafe<any[]>(dataQuery),
      prisma.$queryRawUnsafe<Array<{ count: bigint, expiry_month: string}>>(countQuery),
    ]);

    const totalCount = Number(countResult?.[0]?.count || 0);
    const totalPages = Math.ceil(totalCount / limitNum) || 1;
    const expiry_month = countResult?.[0]?.expiry_month;

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
    console.error("Error fetching covered calls hourly trend:", error);
    return res.status(500).json({
      success: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
