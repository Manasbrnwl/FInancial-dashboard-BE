import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

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

    if (symbol) {
      where.symbol = symbol;
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

    const [data, total] = await Promise.all([
      prisma.nse_options.findMany({
        where,
        orderBy: { date: "desc" },
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.nse_options.count({ where }),
    ]);

    res.json({
      success: true,
      data: data.map(normalizeBigInt),
      pagination: {
        total,
        limit: Number(limit),
        offset: Number(offset),
        hasMore: Number(offset) + data.length < total,
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
