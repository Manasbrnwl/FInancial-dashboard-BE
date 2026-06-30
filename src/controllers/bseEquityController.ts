import { Request, Response } from "express";
import prisma from "../config/prisma";

import { devError, prodError } from "../utils/errorLogger";
import { parseLimitOffset } from "../utils/validation";

export const getBseEquityData = async (req: Request, res: Response) => {
  try {
    const { symbol, startDate, endDate } = req.query;
    const { limit, offset } = parseLimitOffset(req.query, 100);

    const where: any = {};

    if (symbol) {
      where.symbol = symbol as string;
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
      prisma.bse_equity.findMany({
        where,
        orderBy: { date: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.bse_equity.count({ where }),
    ]);

    res.json({
      success: true,
      data,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + data.length < total,
      },
    });
  } catch (error: any) {
    devError("Error fetching BSE equity data:", error);
    prodError("Error fetching BSE equity data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch BSE equity data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getBseEquitySymbols = async (req: Request, res: Response) => {
  try {
    const symbols = await prisma.bse_equity.findMany({
      distinct: ["symbol"],
      select: { symbol: true },
      orderBy: { symbol: "asc" },
    });

    res.json({
      success: true,
      data: symbols.map((s) => s.symbol),
    });
  } catch (error: any) {
    devError("Error fetching BSE equity symbols:", error);
    prodError("Error fetching BSE equity symbols");
    res.status(500).json({
      success: false,
      error: "Failed to fetch BSE equity symbols",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

export const getBseEquityLatest = async (req: Request, res: Response) => {
  try {
    const { symbol } = req.params;

    const latest = await prisma.bse_equity.findFirst({
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
    devError("Error fetching latest BSE equity data:", error);
    prodError("Error fetching latest BSE equity data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch latest BSE equity data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};
