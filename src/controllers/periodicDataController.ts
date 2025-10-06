import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// OHLC Data NSE
export const getOhlcDataNSE = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime, limit = 100, offset = 0 } =
      req.query;

    const where: any = {};

    if (instrumentId) {
      where.instrumentId = Number(instrumentId);
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
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.ohlcDataNSE.count({ where }),
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
    console.error("Error fetching OHLC NSE data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch OHLC NSE data",
      message: error.message,
    });
  }
};

// Ticks Data NSE EQ
export const getTicksDataNSEEQ = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime, limit = 100, offset = 0 } =
      req.query;

    const where: any = {};

    if (instrumentId) {
      where.instrumentId = Number(instrumentId);
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
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.ticksDataNSEEQ.count({ where }),
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
    console.error("Error fetching Ticks NSE EQ data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch Ticks NSE EQ data",
      message: error.message,
    });
  }
};

// Ticks Data NSE FUT
export const getTicksDataNSEFUT = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime, limit = 100, offset = 0 } =
      req.query;

    const where: any = {};

    if (instrumentId) {
      where.instrumentId = Number(instrumentId);
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
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.ticksDataNSEFUT.count({ where }),
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
    console.error("Error fetching Ticks NSE FUT data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch Ticks NSE FUT data",
      message: error.message,
    });
  }
};

// Ticks Data NSE OPT
export const getTicksDataNSEOPT = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime, limit = 100, offset = 0 } =
      req.query;

    const where: any = {};

    if (instrumentId) {
      where.instrumentId = Number(instrumentId);
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
        take: Number(limit),
        skip: Number(offset),
      }),
      prisma.ticksDataNSEOPT.count({ where }),
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
    console.error("Error fetching Ticks NSE OPT data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch Ticks NSE OPT data",
      message: error.message,
    });
  }
};

// OHLC Data BSE
export const getOhlcDataBSE = async (req: Request, res: Response) => {
  try {
    const { instrumentId, startTime, endTime, limit = 100, offset = 0 } =
      req.query;

    const where: any = {};

    if (instrumentId) {
      where.instrumentId = BigInt(instrumentId as string);
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
        take: Number(limit),
        skip: Number(offset),
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
        limit: Number(limit),
        offset: Number(offset),
        hasMore: Number(offset) + data.length < total,
      },
    });
  } catch (error: any) {
    console.error("Error fetching OHLC BSE data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch OHLC BSE data",
      message: error.message,
    });
  }
};
