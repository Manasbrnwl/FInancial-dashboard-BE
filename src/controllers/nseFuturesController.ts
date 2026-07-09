import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
import prisma from "../config/prisma";
import { parseLimitOffset, parseDateRange } from "../utils/validation";

import { devError, prodError } from "../utils/errorLogger";

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
    } = req.query;

    const { limit, offset } = parseLimitOffset(req.query, 360);

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

    where.date = parseDateRange({ startDate, endDate });

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

    let underlyingSymbol: string | null = null;
    if (where.underlying !== undefined && where.underlying !== null) {
      const inst = await prisma.instrument_lists.findUnique({
        where: { id: where.underlying },
        select: { instrument_type: true },
      });
      if (inst) {
        underlyingSymbol = inst.instrument_type;
      }
    }

    const equityJoinCondition = underlyingSymbol 
      ? Prisma.sql`ne.symbol = ${underlyingSymbol} AND nf.date = ne.date`
      : Prisma.sql`il.instrument_type = ne.symbol AND nf.date = ne.date`;

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
        ON ${equityJoinCondition}
        ${where.date?.gte ? Prisma.sql`AND ne.date >= ${where.date.gte}` : Prisma.empty}
        ${where.date?.lte ? Prisma.sql`AND ne.date <= ${where.date.lte}` : Prisma.empty}
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY nf.date DESC
      LIMIT ${limit}
      OFFSET ${offset}
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
        limit,
        offset,
        hasMore: offset + data.length < total,
      },
    });
  } catch (error: any) {
    devError("Error fetching NSE futures data:", error);
    prodError("Error fetching NSE futures data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE futures data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
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
    devError("Error fetching NSE futures underlyings:", error);
    prodError("Error fetching NSE futures underlyings");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE futures underlyings",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getNseFuturesExpiries = async (req: Request, res: Response) => {
  try {
    const { underlying } = req.query;

    const where: any = {};
    if (underlying) {
      const parsedUnderlying = parseInt(underlying as string, 10);
      if (!isNaN(parsedUnderlying)) {
        where.underlying = parsedUnderlying;
      } else {
        where.underlying = -1; // impossible match to return empty list
      }
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
    devError("Error fetching NSE futures expiries:", error);
    prodError("Error fetching NSE futures expiries");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE futures expiries",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
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

    let row, hourly_row;

    if (param === null) {
      // Global min/max is much faster without JOINs and ORs
      const [globalRows, globalHourlyMin, globalHourlyMax] = await Promise.all([
        prisma.$queryRaw<{ min_date: string | null; max_date: string | null }[]>`
          SELECT TO_CHAR(MIN(date), 'yyyy-mm-dd') AS min_date, TO_CHAR(MAX(date), 'yyyy-mm-dd') AS max_date 
          FROM market_data.nse_futures
        `,
        prisma.$queryRaw<{ min_date: string | null }[]>`
          SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS min_date 
          FROM periodic_market_data."ticksDataNSEFUT"
          ORDER BY time ASC LIMIT 1
        `,
        prisma.$queryRaw<{ max_date: string | null }[]>`
          SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS max_date 
          FROM periodic_market_data."ticksDataNSEFUT"
          ORDER BY time DESC LIMIT 1
        `
      ]);
      row = globalRows[0] || { min_date: null, max_date: null };
      hourly_row = {
        min_date: globalHourlyMin[0]?.min_date || null,
        max_date: globalHourlyMax[0]?.max_date || null,
      };
    } else {
      const derivativeIds = await prisma.symbols_list.findMany({
        where: {
          instrument_id: param,
          segment: "FUT",
        },
        select: { id: true },
      });
      const ids = derivativeIds.map((d) => d.id);

      let filteredRows: any[] = [];
      let filteredHourlyMin: any[] = [];
      let filteredHourlyMax: any[] = [];

      if (ids.length > 0) {
        [filteredRows, filteredHourlyMin, filteredHourlyMax] = await Promise.all([
          prisma.$queryRaw<{ min_date: string | null; max_date: string | null }[]>`
            SELECT TO_CHAR(MIN(date), 'yyyy-mm-dd') AS min_date, TO_CHAR(MAX(date), 'yyyy-mm-dd') AS max_date 
            FROM market_data.nse_futures
            WHERE underlying = ${param}
          `,
          prisma.$queryRaw<{ min_date: string | null }[]>`
            SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS min_date 
            FROM periodic_market_data."ticksDataNSEFUT"
            WHERE "instrumentId" = ANY(${ids})
            ORDER BY time ASC LIMIT 1
          `,
          prisma.$queryRaw<{ max_date: string | null }[]>`
            SELECT TO_CHAR(time, 'yyyy-mm-dd HH12:MI AM') AS max_date 
            FROM periodic_market_data."ticksDataNSEFUT"
            WHERE "instrumentId" = ANY(${ids})
            ORDER BY time DESC LIMIT 1
          `
        ]);
      } else {
        filteredRows = await prisma.$queryRaw<{ min_date: string | null; max_date: string | null }[]>`
          SELECT TO_CHAR(MIN(date), 'yyyy-mm-dd') AS min_date, TO_CHAR(MAX(date), 'yyyy-mm-dd') AS max_date 
          FROM market_data.nse_futures
          WHERE underlying = ${param}
        `;
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
    devError("Error fetching futures date range:", error);
    prodError("Error fetching futures date range");
    res.status(500).json({
      success: false,
      error: "Failed to fetch futures date range",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};
