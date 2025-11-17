import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const getNseFuturesData = async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      underlying,
      expiryDate,
      startDate,
      endDate,
      limit = 100,
      offset = 0,
    } = req.query;

    const where: any = {};

    if (symbol) {
      where.symbol = symbol as string;
    }

    if (underlying) {
      where.underlying = underlying as string;
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

    const [data, total] = await Promise.all([
      prisma.nse_futures.findMany({
        where,
        orderBy: { date: "desc" },
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.nse_futures.count({ where }),
    ]);

    res.json({
      success: true,
      data,
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset),
        hasMore: Number(offset) + data.length < total,
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
      SELECT MIN(date) AS min_date, MAX(date) AS max_date
      FROM market_data.nse_futures nf
      WHERE nf.underlying = COALESCE(${param}, nf.underlying)
    `;

    const hourlyrows = await prisma.$queryRaw<
      { min_date: Date | null; max_date: Date | null }[]
    >`
      SELECT MIN(time) AS min_date, MAX(time) AS max_date 
      FROM periodic_market_data."ticksDataNSEFUT" nf 
      INNER JOIN market_data.symbols_list sl ON nf."instrumentId" = sl.id 
      WHERE sl.instrument_id  = COALESCE(${param}, sl.instrument_id)
    `;

    const row = rows[0] || { min_date: null, max_date: null };
    const hourly_row = hourlyrows[0] || { min_date: null, max_date: null };
    res.json({
      success: true,
      min_date: row.min_date ? row.min_date.toISOString().slice(0, 10) : null,
      max_date: row.max_date ? row.max_date.toISOString().slice(0, 10) : null,
      hourly_min_date: hourly_row.min_date
        ? hourly_row.min_date.toISOString()
        : null,
      hourly_max_date: hourly_row.max_date
        ? hourly_row.max_date.toISOString()
        : null,
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
