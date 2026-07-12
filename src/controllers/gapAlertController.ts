import { Request, Response } from "express";
import prisma from "../config/prisma";
import { logger } from "../utils/logger";
import { loadEnv } from "../config/env";
import { loadGapBaselines } from "../cache/gapAverageCache";
import { devError, prodError } from "../utils/errorLogger";
import { parseInteger, parseLimitOffset } from "../utils/validation";

loadEnv();

export const getRecentAlerts = async (req: Request, res: Response) => {
  try {
    const { alertType, instrumentId } = req.query;
    const limit = Math.min(parseInteger(req.query.limit, 100), 500);
    const hours = Math.min(parseInteger(req.query.hours, 24), 72);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const where: any = {
      triggered_at: { gte: since },
    };

    if (alertType) {
      where.alert_type = alertType as string;
    }

    if (instrumentId) {
      const parsedId = Number(instrumentId);
      if (!Number.isNaN(parsedId)) {
        where.instrument_id = parsedId;
      }
    }

    const alerts = await prisma.gap_alerts.findMany({
      where,
      orderBy: { triggered_at: "desc" },
      take: limit,
    });

    const serializedData = alerts.map((row) => ({
      ...row,
      id: row.id.toString(),
    }));

    return res.status(200).json({ success: true, data: serializedData });
  } catch (error: any) {
    devError("⚠️ Failed to fetch recent gap alerts:", error?.message || error);
    prodError("Failed to fetch recent gap alerts");
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent gap alerts",
      ...(process.env.NODE_ENV !== "production" && { error: error?.message || "Unknown error" }),
    });
  }
};

export const getAlertHistory = async (req: Request, res: Response) => {
  try {
    const { alertType, instrumentId } = req.query;
    const { limit, offset, page } = parseLimitOffset(req.query, 50);

    const where: any = {};

    if (alertType) {
      where.alert_type = alertType as string;
    }

    if (instrumentId) {
      const parsedId = Number(instrumentId);
      if (!Number.isNaN(parsedId)) {
        where.instrument_id = parsedId;
      }
    }

    const [data, total] = await Promise.all([
      prisma.gap_alerts.findMany({
        where,
        skip: offset,
        take: limit,
        orderBy: { triggered_at: "desc" },
      }),
      prisma.gap_alerts.count({ where }),
    ]);

    const serializedData = data.map((row) => ({
      ...row,
      id: row.id.toString(),
    }));

    return res.status(200).json({
      success: true,
      data: serializedData,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    devError("⚠️ Failed to fetch gap alert history:", error?.message || error);
    prodError("Failed to fetch gap alert history");
    return res.status(500).json({
      success: false,
      message: "Failed to fetch alert history",
      ...(process.env.NODE_ENV !== "production" && { error: error?.message || "Unknown error" }),
    });
  }
};

export const getGapHistory = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.params;
    const days = Math.min(parseInteger(req.query.days, 20), 60);

    if (!instrumentId) {
      return res.status(400).json({
        success: false,
        message: "instrumentId is required",
      });
    }

    const since = new Date();
    since.setDate(since.getDate() - days);

    const data = await prisma.gap_time_series.findMany({
      where: {
        instrument_id: Number(instrumentId),
        date: { gte: since },
      },
      orderBy: [{ date: "desc" }, { time_slot: "desc" }],
    });

    const serializedData = data.map((row) => ({
      ...row,
      id: row.id.toString(),
    }));

    return res.status(200).json({ success: true, data: serializedData });
  } catch (error: any) {
    devError("⚠️ Failed to fetch gap history:", error?.message || error);
    prodError("Failed to fetch gap history");
    return res.status(500).json({
      success: false,
      message: "Failed to fetch gap history",
      ...(process.env.NODE_ENV !== "production" && { error: error?.message || "Unknown error" }),
    });
  }
};

export const reloadGapBaselines = async (_req: Request, res: Response) => {
  try {
    await loadGapBaselines();
    return res.status(200).json({
      success: true,
      message: "Gap baselines refreshed",
    });
  } catch (error: any) {
    devError("⚠️ Failed to reload gap baselines:", error?.message || error);
    prodError("Failed to reload gap baselines");
    return res.status(500).json({
      success: false,
      message: "Failed to reload gap baselines",
      ...(process.env.NODE_ENV !== "production" && { error: error?.message || "Unknown error" }),
    });
  }
};
