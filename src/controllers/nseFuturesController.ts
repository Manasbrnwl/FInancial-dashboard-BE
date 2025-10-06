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

export const getNseFuturesUnderlyings = async (
  req: Request,
  res: Response
) => {
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
