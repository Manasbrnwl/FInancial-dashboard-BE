import { Request, Response } from "express";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { devError, prodError } from "../utils/errorLogger";
import { parseLimitOffset } from "../utils/validation";

// OHLC Data NSE
export const getOhlcDataNSE = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime } = req.query;
    const { limit, offset } = parseLimitOffset(req.query, 100);

    const where: any = {};

    if (instrumentId) {
      const parsedId = Number(instrumentId);
      if (!Number.isNaN(parsedId)) {
        where.instrumentId = parsedId;
      }
    }

    if (startTime || endTime) {
      where.time = {};
      if (startTime) {
        where.time.gte = new Date(startTime as string);
      }
      if (endTime) {
        where.time.lte = new Date(endTime as string);
      }
    }

    const [data, total] = await Promise.all([
      prisma.ohlcDataNSE.findMany({
        where,
        orderBy: { time: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.ohlcDataNSE.count({ where }),
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
    devError("Error fetching OHLC NSE data:", error);
    prodError("Error fetching OHLC NSE data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch OHLC NSE data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

// Ticks Data NSE EQ
export const getTicksDataNSEEQ = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime } = req.query;
    const { limit, offset } = parseLimitOffset(req.query, 100);

    const where: any = {};

    if (instrumentId) {
      const parsedId = Number(instrumentId);
      if (!Number.isNaN(parsedId)) {
        where.instrumentId = parsedId;
      }
    }

    if (startTime || endTime) {
      where.time = {};
      if (startTime) {
        where.time.gte = new Date(startTime as string);
      }
      if (endTime) {
        where.time.lte = new Date(endTime as string);
      }
    }

    const [data, total] = await Promise.all([
      prisma.ticksDataNSEEQ.findMany({
        where,
        orderBy: { time: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.ticksDataNSEEQ.count({ where }),
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
    devError("Error fetching Ticks NSE EQ data:", error);
    prodError("Error fetching Ticks NSE EQ data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch Ticks NSE EQ data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

// Ticks Data NSE FUT
export const getTicksDataNSEFUT = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime } = req.query;
    const { limit, offset } = parseLimitOffset(req.query, 100);

    const where: any = {};

    if (instrumentId) {
      const parsedId = Number(instrumentId);
      if (!Number.isNaN(parsedId)) {
        where.instrumentId = parsedId;
      }
    }

    if (startTime || endTime) {
      where.time = {};
      if (startTime) {
        where.time.gte = new Date(startTime as string);
      }
      if (endTime) {
        where.time.lte = new Date(endTime as string);
      }
    }

    const [data, total] = await Promise.all([
      prisma.ticksDataNSEFUT.findMany({
        where,
        orderBy: { time: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.ticksDataNSEFUT.count({ where }),
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
    devError("Error fetching Ticks NSE FUT data:", error);
    prodError("Error fetching Ticks NSE FUT data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch Ticks NSE FUT data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

// Ticks Data NSE OPT
export const getTicksDataNSEOPT = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime } = req.query;
    const { limit, offset } = parseLimitOffset(req.query, 100);

    const where: any = {};

    if (instrumentId) {
      const parsedId = Number(instrumentId);
      if (!Number.isNaN(parsedId)) {
        where.instrumentId = parsedId;
      }
    }

    if (startTime || endTime) {
      where.time = {};
      if (startTime) {
        where.time.gte = new Date(startTime as string);
      }
      if (endTime) {
        where.time.lte = new Date(endTime as string);
      }
    }

    const [data, total] = await Promise.all([
      prisma.ticksDataNSEOPT.findMany({
        where,
        orderBy: { time: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.ticksDataNSEOPT.count({ where }),
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
    devError("Error fetching Ticks NSE OPT data:", error);
    prodError("Error fetching Ticks NSE OPT data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch Ticks NSE OPT data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};

// OHLC Data BSE
export const getOhlcDataBSE = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime } = req.query;
    const { limit, offset } = parseLimitOffset(req.query, 100);

    const where: any = {};

    if (instrumentId) {
      const parsedInt = parseInt(instrumentId as string, 10);
      if (!Number.isNaN(parsedInt)) {
        where.instrumentId = BigInt(instrumentId as string);
      } else {
        where.instrumentId = BigInt(-1);
      }
    }

    if (startTime || endTime) {
      where.time = {};
      if (startTime) {
        where.time.gte = new Date(startTime as string);
      }
      if (endTime) {
        where.time.lte = new Date(endTime as string);
      }
    }

    const [data, total] = await Promise.all([
      prisma.ohlcEQDataBSE.findMany({
        where,
        orderBy: { time: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.ohlcEQDataBSE.count({ where }),
    ]);

    // Convert BigInt to string for JSON serialization
    const serializedData = data.map((item) => ({
      ...item,
      id: item.id.toString(),
      instrumentId: item.instrumentId.toString(),
    }));

    res.json({
      success: true,
      data: serializedData,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + data.length < total,
      },
    });
  } catch (error: any) {
    devError("Error fetching OHLC BSE data:", error);
    prodError("Error fetching OHLC BSE data");
    res.status(500).json({
      success: false,
      error: "Failed to fetch OHLC BSE data",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};
