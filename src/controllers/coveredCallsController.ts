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
      filterCondition += ` AND premium_percentage >= ${minPremium}`;
    }
    if (maxPremium !== null) {
      filterCondition += ` AND premium_percentage <= ${maxPremium}`;
    }

    // Get total count with filters
    const countResult = await prisma.$queryRaw<
      Array<{ count: bigint; avg_premium: string }>
    >`
    WITH latest_tick_opt AS (
        SELECT DISTINCT ON ("instrumentId")
            "instrumentId", ltp, volume
        FROM periodic_market_data."ticksDataNSEOPT"
        ORDER BY "instrumentId", id DESC
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
            s.symbol,
            s.instrument_id,
            s.strike::numeric strike,
            (REGEXP_MATCHES(s.symbol, '(CE|PE)$'))[1] AS option_type
        FROM market_data.symbols_list s
        WHERE s.segment = 'OPT'
        AND s.expiry_date >= CURRENT_DATE
    ),
    with_calcs AS (
        SELECT
            i.instrument_type AS underlying,
            se.symbol AS option_symbol,
            e.ltp::numeric AS underlying_price,
            o.ltp::numeric AS premium,
            o.volume,
            se.strike,
            se.option_type,
            ABS(ROUND(((se.strike::numeric / e.ltp::numeric) - 1) * 100, 2)) AS otm,
            ABS(ROUND((o.ltp::numeric / e.ltp::numeric) * 100, 2)) AS premium_percentage
        FROM market_data.instrument_lists i
        JOIN strike_extraction se ON i.id = se.instrument_id
        JOIN latest_tick_opt o ON se.id = o."instrumentId"
        JOIN latest_tick_eq e ON i.id = e."instrumentId"
    )
    SELECT COUNT(*) as count, round(avg(premium_percentage),2) as avg_premium
    FROM with_calcs
    WHERE 1=1 ${Prisma.raw(filterCondition)}
    `;

    const totalCount = Number(countResult[0]?.count || 0);
    const avg_premium = Number(countResult[0]?.avg_premium || 0.00)

    // Get paginated and filtered data
    const coveredCallsData = await prisma.$queryRaw<
      Array<{
        underlying: string;
        underlying_price: number;
        option_symbol: string;
        premium: number;
        volume: number;
        strike: number;
        option_type: string;
        otm: number;
        premium_percentage: number;
      }>
    >`
    WITH latest_tick_opt AS (
        SELECT DISTINCT ON ("instrumentId")
            "instrumentId", ltp, volume
        FROM periodic_market_data."ticksDataNSEOPT"
        ORDER BY "instrumentId", id DESC
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
            (REGEXP_MATCHES(s.symbol, '(CE|PE)$'))[1] AS option_type
        FROM market_data.symbols_list s
        WHERE s.segment = 'OPT'
        AND s.expiry_date >= CURRENT_DATE
    ),
    with_calcs AS (
        SELECT
            i.instrument_type AS underlying,
            se.symbol AS option_symbol,
            e.ltp::numeric AS underlying_price,
            o.ltp::numeric AS premium,
            o.volume,
            se.strike,
            se.option_type,
            ABS(ROUND(((se.strike::numeric / e.ltp::numeric) - 1) * 100, 2)) AS otm,
            ABS(ROUND((o.ltp::numeric / e.ltp::numeric) * 100, 2)) AS premium_percentage
        FROM market_data.instrument_lists i
        JOIN strike_extraction se ON i.id = se.instrument_id
        JOIN latest_tick_opt o ON se.id = o."instrumentId"
        JOIN latest_tick_eq e ON i.id = e."instrumentId"
    )
    SELECT
        underlying,
        option_symbol,
        underlying_price,
        premium,
        volume,
        strike,
        option_type,
        otm,
        premium_percentage
    FROM with_calcs
    WHERE 1=1 ${Prisma.raw(filterCondition)}
    ORDER BY underlying, strike
    LIMIT ${limit}
    OFFSET ${offset}
    `;
    // console.log(coveredCallsData)
    // Transform the data to proper format with type conversions
    const transformedData = coveredCallsData.map((item) => ({
      underlyingSymbol: item.underlying,
      underlyingPrice: item.underlying_price || null,
      optionSymbol: item.option_symbol,
      premium: item.premium || null,
      volume: item.volume || null,
      strikePrice: item.strike || null,
      optionType: item.option_type,
      otm: item.otm || null,
      premiumPercent: item.premium_percentage || null,
    }));

    res.json({
      success: true,
      data: transformedData,
      count: transformedData.length,
      avg_premium,
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
