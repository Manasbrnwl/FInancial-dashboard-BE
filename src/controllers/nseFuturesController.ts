import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";

const normalizeBigInt = (row: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ])
  );

export const getNseFuturesData = async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      underlying,
      expiryDate,
      startDate,
      endDate,
      limit = 360,
      offset = 0,
    } = req.query;

    const where: any = {};

    const parseNumberOrNull = (value: any) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };

    if (symbol) {
      const numericSymbol = parseNumberOrNull(symbol);
      if (numericSymbol !== null) {
        where.symbol = numericSymbol;
      }
    }

    if (underlying !== undefined && underlying !== null) {
      const numericUnderlying = Number(underlying);
      if (
        !Number.isNaN(numericUnderlying) &&
        Number.isFinite(numericUnderlying)
      ) {
        where.underlying = numericUnderlying;
      }
    }

    if (expiryDate) {
      where.expiry_date = new Date(expiryDate as string);
    }

    if (startDate || endDate) {
      where.date = {};
      if (startDate) {
        where.date.gte = new Date(startDate as string);
      }
      if (endDate) {
        where.date.lte = new Date(endDate as string);
      }
    }

    const filters: Prisma.Sql[] = [];

    if (where.symbol !== undefined) {
      filters.push(Prisma.sql`nf.symbol = ${where.symbol}`);
    }
    if (where.underlying !== undefined) {
      filters.push(Prisma.sql`nf.underlying = ${where.underlying}`);
    }
    if (where.expiry_date) {
      filters.push(Prisma.sql`nf.expiry_date = ${where.expiry_date}`);
    }
    if (where.date?.gte) {
      filters.push(Prisma.sql`nf.date >= ${where.date.gte}`);
    }
    if (where.date?.lte) {
      filters.push(Prisma.sql`nf.date <= ${where.date.lte}`);
    }

    if (filters.length === 0) {
      filters.push(Prisma.sql`1=1`);
    }

    const limitNumber = Number.isFinite(Number(limit)) ? Number(limit) : 360;
    const offsetNumber = Number.isFinite(Number(offset)) ? Number(offset) : 0;

    const joinedQuery = Prisma.sql`
      SELECT
        nf.symbol,
        nf.underlying,
        nf.expiry_date,
        nf.date,
        nf.open,
        nf.high,
        nf.low,
        nf.close,
        nf.volume,
        ne.close AS equity_close,
        ((ne.close - nf.close)/ne.close)*100 AS gap_percentage
      FROM market_data.nse_futures nf
      LEFT JOIN market_data.instrument_lists il ON nf.underlying = il.id
      LEFT JOIN market_data.nse_equity ne
        ON il.instrument_type = ne.symbol
        AND nf.date = ne.date
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY nf.date DESC
      LIMIT ${limitNumber}
      OFFSET ${offsetNumber}
    `;

    const [data, total] = await Promise.all([
      prisma.$queryRaw<any[]>(joinedQuery),
      prisma.nse_futures.count({ where }),
    ]);

    res.json({
      success: true,
      data: data.map(normalizeBigInt),
      pagination: {
        total,
        limit: limitNumber,
        offset: offsetNumber,
        hasMore: offsetNumber + data.length < total,
      },
    });
  } catch (error: any) {
    console.error("Error fetching NSE futures data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE futures data",
      message: error.message,
    });
  }
};

export const getNseFuturesUnderlyings = async (req: Request, res: Response) => {
  try {
    const underlyings = await prisma.nse_futures.findMany({
      distinct: ["underlying"],
      select: { underlying: true },
      orderBy: { underlying: "asc" },
    });

    res.json({
      success: true,
      data: underlyings.map((u) => u.underlying),
    });
  } catch (error: any) {
    console.error("Error fetching NSE futures underlyings:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE futures underlyings",
      message: error.message,
    });
  }
};

export const getNseFuturesExpiries = async (req: Request, res: Response) => {
  try {
    const { underlying } = req.query;

    const where: any = {};
    if (underlying) {
      where.underlying = underlying as string;
    }

    const expiries = await prisma.nse_futures.findMany({
      distinct: ["expiry_date"],
      select: { expiry_date: true },
      where,
      orderBy: { expiry_date: "asc" },
    });

    res.json({
      success: true,
      data: expiries.map((e) => e.expiry_date),
    });
  } catch (error: any) {
    console.error("Error fetching NSE futures expiries:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE futures expiries",
      message: error.message,
    });
  }
};

// GET /api/nse-futures/date-range?instrumentId=ID|null
export const getFuturesDateRangeController = async (
  req: Request,
  res: Response
) => {
  try {
    const { instrumentId } = req.query;
    const param =
      instrumentId === undefined ||
      instrumentId === null ||
      instrumentId === "null"
        ? null
        : Number(instrumentId);
    if (param !== null && (isNaN(param) || !isFinite(param))) {
      return res.status(400).json({
        success: false,
        error: "instrumentId must be a number or null",
      });
    }

    const rows = await prisma.$queryRaw<
      { min_date: Date | null; max_date: Date | null }[]
    >`
      SELECT TO_CHAR(MIN(date), 'yyyy-mm-dd') AS min_date, TO_CHAR(MAX(date), 'yyyy-mm-dd') AS max_date 
      FROM market_data.nse_futures nf
      WHERE  (${param} IS NULL OR nf.underlying = ${param})
    `;

    const hourlyrows = await prisma.$queryRaw<
      { min_date: Date | null; max_date: Date | null }[]
    >`
      SELECT TO_CHAR(MIN(time), 'yyyy-mm-dd HH12:MI AM') AS min_date, TO_CHAR(MAX(time), 'yyyy-mm-dd HH12:MI AM') AS max_date 
      FROM periodic_market_data."ticksDataNSEFUT" nf 
      INNER JOIN market_data.symbols_list sl ON nf."instrumentId" = sl.id 
      WHERE sl.instrument_id  = COALESCE(${param}, sl.instrument_id)
    `;

    const row = rows[0] || { min_date: null, max_date: null };
    const hourly_row = hourlyrows[0] || { min_date: null, max_date: null };
    res.json({
      success: true,
      min_date: row.min_date && row.min_date,
      max_date: row.max_date && row.max_date,
      hourly_min_date: hourly_row.min_date && hourly_row.min_date,
      hourly_max_date: hourly_row.max_date && hourly_row.max_date,
    });
  } catch (error: any) {
    console.error("Error fetching futures date range:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch futures date range",
      message: error.message,
    });
  }
};
