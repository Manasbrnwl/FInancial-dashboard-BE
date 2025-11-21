import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { loadEnv } from "../config/env";
import { loadGapBaselines } from "../cache/gapAverageCache";

loadEnv();

const prisma = new PrismaClient();

function parseInteger(value: string | undefined, fallback: number): number {
  const parsed = parseInt(value || "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const getRecentAlerts = async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInteger(req.query.limit as string, 100), 500);
    const hours = Math.min(parseInteger(req.query.hours as string, 24), 72);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const alerts = await prisma.gap_alerts.findMany({
      where: { triggered_at: { gte: since } },
      orderBy: { triggered_at: "desc" },
      take: limit,
    });

    return res.status(200).json({ success: true, data: alerts });
  } catch (error: any) {
    console.error("? Failed to fetch recent gap alerts:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch recent gap alerts",
      error: error?.message || "Unknown error",
    });
  }
};

export const getAlertHistory = async (req: Request, res: Response) => {
  try {
    const page = Math.max(parseInteger(req.query.page as string, 1), 1);
    const limit = Math.min(parseInteger(req.query.limit as string, 50), 200);
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      prisma.gap_alerts.findMany({
        skip,
        take: limit,
        orderBy: { triggered_at: "desc" },
      }),
      prisma.gap_alerts.count(),
    ]);

    return res.status(200).json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error: any) {
    console.error("? Failed to fetch gap alert history:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch alert history",
      error: error?.message || "Unknown error",
    });
  }
};

export const getGapHistory = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.params;
    const days = Math.min(parseInteger(req.query.days as string, 20), 60);

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

    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    console.error("? Failed to fetch gap history:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch gap history",
      error: error?.message || "Unknown error",
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
    console.error("? Failed to reload gap baselines:", error?.message || error);
    return res.status(500).json({
      success: false,
      message: "Failed to reload gap baselines",
      error: error?.message || "Unknown error",
    });
  }
};
