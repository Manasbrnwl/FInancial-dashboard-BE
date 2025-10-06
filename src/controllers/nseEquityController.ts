import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const getNseEquityData = async (req: Request, res: Response) => {
  try {
    const { symbol, startDate, endDate, limit = 100, offset = 0 } = req.query;

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
      prisma.nse_equity.findMany({
        where,
        orderBy: { date: "desc" },
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.nse_equity.count({ where }),
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
    console.error("Error fetching NSE equity data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE equity data",
      message: error.message,
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
    console.error("Error fetching NSE equity symbols:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE equity symbols",
      message: error.message,
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
    console.error("Error fetching latest NSE equity data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch latest NSE equity data",
      message: error.message,
    });
  }
};
