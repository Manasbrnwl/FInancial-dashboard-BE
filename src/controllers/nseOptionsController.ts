import { Request, Response } from "express";
import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

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
      limit = 360,
      offset = 0,
    } = req.query;

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

    const limitNumber = Number.isFinite(Number(limit)) ? Number(limit) : 360;
    const offsetNumber = Number.isFinite(Number(offset)) ? Number(offset) : 0;

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
        ON il.instrument_type = ne.symbol
        AND no.date = ne.date
      WHERE ${Prisma.join(filters, " AND ")}
      ORDER BY no.date DESC
      LIMIT ${limitNumber}
      OFFSET ${offsetNumber}
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
        limit: limitNumber,
        offset: offsetNumber,
        hasMore: offsetNumber + data.length < total,
      },
    });
  } catch (error: any) {
    console.error("Error fetching NSE options data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options data",
      message: error.message,
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
    console.error("Error fetching NSE options underlyings:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options underlyings",
      message: error.message,
    });
  }
};

export const getNseOptionsStrikes = async (req: Request, res: Response) => {
  try {
    const { underlying, expiryDate } = req.query;

    const where: any = {};
    if (underlying) {
      where.underlying = underlying as string;
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
    console.error("Error fetching NSE options strikes:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options strikes",
      message: error.message,
    });
  }
};

export const getNseOptionsExpiries = async (req: Request, res: Response) => {
  try {
    const { underlying } = req.query;

    const where: any = {};
    if (underlying) {
      where.underlying = underlying as string;
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
    console.error("Error fetching NSE options expiries:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE options expiries",
      message: error.message,
    });
  }
};
