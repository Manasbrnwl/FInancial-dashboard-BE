import { Request, Response } from "express";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { devError, prodError } from "../utils/errorLogger";
import { parseLimitOffset, parseDateRange } from "../utils/validation";

const normalizeBigInt = (row: Record<string, any>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === "bigint" ? Number(value) : value,
    ])
  );

export const getNseEquityData = async (req: Request, res: Response) => {
  try {
    const { symbol, startDate, endDate } = req.query;
    const { limit, offset } = parseLimitOffset(req.query, 360);

    const where: any = {};

    if (symbol) {
      where.symbol = symbol as string;
    }

    where.date = parseDateRange({ startDate, endDate });

    const [data, total] = await Promise.all([
      prisma.nse_equity.findMany({
        where,
        orderBy: { date: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.nse_equity.count({ where }),
    ]);

    res.json({
      success: true,
      data: data.map(normalizeBigInt),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + data.length < total,
      },
    });
  } catch (error: any) {
    devError("Error fetching NSE equity data:", error);
    prodError("Error fetching NSE equity data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE equity data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getNseEquitySymbols = async (req: Request, res: Response) => {
  try {
    const symbols = await prisma.nse_equity.findMany({
      distinct: ["symbol"],
      select: { symbol: true },
      orderBy: { symbol: "asc" },
    });

    res.json({
      success: true,
      data: symbols.map((s) => s.symbol),
    });
  } catch (error: any) {
    devError("Error fetching NSE equity symbols:", error);
    prodError("Error fetching NSE equity symbols");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE equity symbols",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getNseEquityLatest = async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;

    const latest = await prisma.nse_equity.findFirst({
      where: { symbol },
      orderBy: { date: "desc" },
    });

    if (!latest) {
      return res.status(404).json({
        success: false,
        error: "No data found for symbol",
      });
    }

    res.json({
      success: true,
      data: latest,
    });
  } catch (error: any) {
    devError("Error fetching latest NSE equity data:", error);
    prodError("Error fetching latest NSE equity data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch latest NSE equity data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

// GET /api/nse-equity/date-range?symbol=SYM|null
export const getEquityDateRangeController = async (
  req: Request,
  res: Response
) => {
  try {
    const { symbol } = req.query;
    const param =
      symbol === undefined || symbol === null || symbol === "null"
        ? null
        : String(symbol);

    let row, hourly_row;

    if (param === null) {
      const [globalRows, globalHourlyMin, globalHourlyMax] = await Promise.all([
        prisma.$queryRaw<{ min_date: string | null; max_date: string | null }[]>`
          SELECT TO_CHAR(MIN(date), 'yyyy-mm-dd') AS min_date, TO_CHAR(MAX(date), 'yyyy-mm-dd') AS max_date 
          FROM market_data.nse_equity
        `,
        prisma.$queryRaw<{ min_date: string | null }[]>`
          SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS min_date 
          FROM periodic_market_data."ticksDataNSEEQ"
          ORDER BY time ASC LIMIT 1
        `,
        prisma.$queryRaw<{ max_date: string | null }[]>`
          SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS max_date 
          FROM periodic_market_data."ticksDataNSEEQ"
          ORDER BY time DESC LIMIT 1
        `
      ]);
      row = globalRows[0] || { min_date: null, max_date: null };
      hourly_row = {
        min_date: globalHourlyMin[0]?.min_date || null,
        max_date: globalHourlyMax[0]?.max_date || null,
      };
    } else {
      const inst = await prisma.instrument_lists.findFirst({
        where: {
          exchange: "NSE",
          instrument_type: param,
        },
        select: { id: true },
      });
      const instrumentId = inst?.id || null;

      let filteredRows: any[] = [];
      let filteredHourlyMin: any[] = [];
      let filteredHourlyMax: any[] = [];

      if (instrumentId !== null) {
        [filteredRows, filteredHourlyMin, filteredHourlyMax] = await Promise.all([
          prisma.$queryRaw<{ min_date: string | null; max_date: string | null }[]>`
            SELECT TO_CHAR(MIN(date), 'yyyy-mm-dd') AS min_date, TO_CHAR(MAX(date), 'yyyy-mm-dd') AS max_date 
            FROM market_data.nse_equity
            WHERE symbol = ${param}
          `,
          prisma.$queryRaw<{ min_date: string | null }[]>`
            SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS min_date 
            FROM periodic_market_data."ticksDataNSEEQ"
            WHERE "instrumentId" = ${instrumentId}
            ORDER BY time ASC LIMIT 1
          `,
          prisma.$queryRaw<{ max_date: string | null }[]>`
            SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS max_date 
            FROM periodic_market_data."ticksDataNSEEQ"
            WHERE "instrumentId" = ${instrumentId}
            ORDER BY time DESC LIMIT 1
          `
        ]);
      }

      row = filteredRows[0] || { min_date: null, max_date: null };
      hourly_row = {
        min_date: filteredHourlyMin[0]?.min_date || null,
        max_date: filteredHourlyMax[0]?.max_date || null,
      };
    }
    res.json({
      success: true,
      min_date: row.min_date && row.min_date,
      max_date: row.max_date && row.max_date,
      hourly_min_date: hourly_row.min_date && hourly_row.min_date,
      hourly_max_date: hourly_row.max_date && hourly_row.max_date,
    });
  } catch (error: any) {
    devError("Error fetching equity date range:", error);
    prodError("Error fetching equity date range");
    res.status(500).json({
      success: false,
      error: "Failed to fetch equity date range",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};
