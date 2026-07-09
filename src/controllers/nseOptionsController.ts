import { Request, Response } from "express";
import { Prisma } from "@prisma/client";
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

export const getNseOptionsData = async (req: Request, res: Response) => {
  try {
    const {
      symbol,
      underlying,
      expiryDate,
      strike,
      optionType,
      startDate,
      endDate,
    } = req.query;

    const { limit, offset } = parseLimitOffset(req.query, 360);

    const where: any = {};

    const parseNumberOrNull = (value: any) => {
      const num = Number(value);
      return Number.isFinite(num) ? num : null;
    };
    const minOtm = parseNumberOrNull(req.query.minOtm);
    const maxOtm = parseNumberOrNull(req.query.maxOtm);
    const minPremium = parseNumberOrNull(req.query.minPremium);
    const maxPremium = parseNumberOrNull(req.query.maxPremium);

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

    if (strike) {
      where.strike = strike as string;
    }

    if (optionType) {
      where.option_type = optionType as string;
    }

    where.date = parseDateRange({ startDate, endDate });

    const filters: Prisma.Sql[] = [];
    const otmExpr = Prisma.sql`
      CASE 
        WHEN ne.close IS NULL OR ne.close = 0 THEN NULL 
        WHEN NULLIF(no.strike, '') IS NULL THEN NULL
        ELSE ((NULLIF(no.strike, '')::numeric - ne.close) / ne.close) * 100 
      END
    `;
    const premiumExpr = Prisma.sql`
      CASE 
        WHEN ne.close IS NULL OR ne.close = 0 THEN NULL 
        ELSE (no.close / ne.close) * 100 
      END
    `;

    if (where.symbol !== undefined) {
      filters.push(Prisma.sql`no.symbol = ${where.symbol}`);
    }
    if (where.underlying !== undefined) {
      filters.push(Prisma.sql`no.underlying = ${where.underlying}`);
    }
    if (where.expiry_date) {
      filters.push(Prisma.sql`no.expiry_date = ${where.expiry_date}`);
    }
    if (where.strike) {
      filters.push(Prisma.sql`no.strike = ${where.strike}`);
    }
    if (where.option_type) {
      filters.push(Prisma.sql`no.option_type = ${where.option_type}`);
    }
    if (where.date?.gte) {
      filters.push(Prisma.sql`no.date >= ${where.date.gte}`);
    }
    if (where.date?.lte) {
      filters.push(Prisma.sql`no.date <= ${where.date.lte}`);
    }
    if (minOtm !== null) {
      filters.push(Prisma.sql`${otmExpr} >= ${minOtm}`);
    }
    if (maxOtm !== null) {
      filters.push(Prisma.sql`${otmExpr} <= ${maxOtm}`);
    }
    if (minPremium !== null) {
      filters.push(Prisma.sql`${premiumExpr} >= ${minPremium}`);
    }
    if (maxPremium !== null) {
      filters.push(Prisma.sql`${premiumExpr} <= ${maxPremium}`);
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
      ? Prisma.sql`ne.symbol = ${underlyingSymbol} AND no.date = ne.date`
      : Prisma.sql`il.instrument_type = ne.symbol AND no.date = ne.date`;

    const joinedQuery = Prisma.sql`
      SELECT
        no.symbol,
        no.expiry_date,
        no.strike,
        no.option_type,
        no.date,
        no.open,
        no.high,
        no.low,
        no.close,
        no.volume,
        ne.close AS equity_close,
        ${otmExpr} as otm_percentage,
        ${premiumExpr} as premium_percentage
      FROM market_data.nse_options no
      LEFT JOIN market_data.instrument_lists il ON no.underlying = il.id
      LEFT JOIN market_data.nse_equity ne
        ON ${equityJoinCondition}
        ${where.date?.gte ? Prisma.sql`AND ne.date >= ${where.date.gte}` : Prisma.empty}
        ${where.date?.lte ? Prisma.sql`AND ne.date <= ${where.date.lte}` : Prisma.empty}
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY no.date DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const [data, total] = await Promise.all([
      prisma.$queryRaw<any[]>(joinedQuery),
      prisma.nse_options.count({ where }),
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
    devError("Error fetching NSE options data:", error);
    prodError("Error fetching NSE options data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getNseOptionsUnderlyings = async (req: Request, res: Response) => {
  try {
    const underlyings = await prisma.nse_options.findMany({
      distinct: ["underlying"],
      select: { underlying: true },
      orderBy: { underlying: "asc" },
    });

    res.json({
      success: true,
      data: underlyings.map((u) => u.underlying),
    });
  } catch (error: any) {
    devError("Error fetching NSE options underlyings:", error);
    prodError("Error fetching NSE options underlyings");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options underlyings",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getNseOptionsStrikes = async (req: Request, res: Response) => {
  try {
    const { underlying, expiryDate } = req.query;

    const where: any = {};
    if (underlying) {
      const parsedUnderlying = parseInt(underlying as string, 10);
      if (!isNaN(parsedUnderlying)) {
        where.underlying = parsedUnderlying;
      } else {
        where.underlying = -1;
      }
    }
    if (expiryDate) {
      where.expiry_date = new Date(expiryDate as string);
    }

    const strikes = await prisma.nse_options.findMany({
      distinct: ["strike"],
      select: { strike: true },
      where,
      orderBy: { strike: "asc" },
    });

    res.json({
      success: true,
      data: strikes.map((s) => s.strike),
    });
  } catch (error: any) {
    devError("Error fetching NSE options strikes:", error);
    prodError("Error fetching NSE options strikes");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options strikes",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getNseOptionsExpiries = async (req: Request, res: Response) => {
  try {
    const { underlying } = req.query;

    const where: any = {};
    if (underlying) {
      const parsedUnderlying = parseInt(underlying as string, 10);
      if (!isNaN(parsedUnderlying)) {
        where.underlying = parsedUnderlying;
      } else {
        where.underlying = -1;
      }
    }

    const expiries = await prisma.nse_options.findMany({
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
    devError("Error fetching NSE options expiries:", error);
    prodError("Error fetching NSE options expiries");
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options expiries",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};
