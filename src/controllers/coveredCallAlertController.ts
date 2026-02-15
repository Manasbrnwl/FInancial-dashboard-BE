import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

import { devError } from "../utils/errorLogger";

const prisma = new PrismaClient();

/**
 * Get recent covered call alerts (for dashboard)
 */
export const getRecentCoveredCallAlerts = async (
    req: Request,
    res: Response
) => {
    try {
        const limit = parseInt(req.query.limit as string) || 20;

        const alerts = await prisma.covered_call_alerts.findMany({
            orderBy: { triggered_at: "desc" },
            take: limit,
        });

        // Convert BigInt to string for JSON serialization
        const safeAlerts = alerts.map((alert) => ({
            ...alert,
            id: alert.id.toString(),
        }));

        res.json({
            success: true,
            data: safeAlerts,
            count: safeAlerts.length,
        });
    } catch (error: any) {
        devError("❌ Failed to fetch recent covered call alerts:", error?.message || error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch recent covered call alerts",
            ...(process.env.NODE_ENV !== "production" && { error: error?.message }),
        });
    }
};

/**
 * Get covered call alert history with pagination and filters
 */
export const getCoveredCallAlertHistory = async (
    req: Request,
    res: Response
) => {
    try {
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 50;
        const offset = (page - 1) * limit;
        const instrumentId = req.query.instrumentId
            ? parseInt(req.query.instrumentId as string)
            : undefined;
        const startDate = req.query.startDate as string;
        const endDate = req.query.endDate as string;

        // Build where clause
        const where: any = {};

        if (instrumentId) {
            where.instrument_id = instrumentId;
        }

        if (startDate || endDate) {
            where.triggered_at = {};
            if (startDate) {
                where.triggered_at.gte = new Date(startDate);
            }
            if (endDate) {
                where.triggered_at.lte = new Date(endDate);
            }
        }

        // Get total count
        const total = await prisma.covered_call_alerts.count({ where });

        // Get paginated data
        const alerts = await prisma.covered_call_alerts.findMany({
            where,
            orderBy: { triggered_at: "desc" },
            skip: offset,
            take: limit,
        });

        // Convert BigInt to string for JSON serialization
        const safeAlerts = alerts.map((alert) => ({
            ...alert,
            id: alert.id.toString(),
        }));

        res.json({
            success: true,
            data: safeAlerts,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
                hasMore: page < Math.ceil(total / limit),
            },
        });
    } catch (error: any) {
        devError("❌ Failed to fetch covered call alert history:", error?.message || error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch covered call alert history",
            ...(process.env.NODE_ENV !== "production" && { error: error?.message }),
        });
    }
};

/**
 * Get alert configuration
 */
export const getCoveredCallAlertConfig = async (
    req: Request,
    res: Response
) => {
    try {
        const instrumentId = req.query.instrumentId
            ? parseInt(req.query.instrumentId as string)
            : undefined;

        const config = await prisma.covered_call_alert_config.findFirst({
            where: instrumentId ? { instrument_id: instrumentId } : { instrument_id: null },
        });

        if (!config) {
            // Return default config
            return res.json({
                success: true,
                data: {
                    min_otm_percent: 4,
                    max_otm_percent: 5,
                    min_premium_percent: 2,
                    max_premium_percent: 2.5,
                    min_upside_percent: 6,
                    max_upside_percent: 7,
                    consecutive_count: 10,
                    cooldown_minutes: 60,
                    is_active: true,
                },
            });
        }

        res.json({
            success: true,
            data: config,
        });
    } catch (error: any) {
        devError("❌ Failed to fetch covered call alert config:", error?.message || error);
        res.status(500).json({
            success: false,
            message: "Failed to fetch covered call alert config",
            ...(process.env.NODE_ENV !== "production" && { error: error?.message }),
        });
    }
};

/**
 * Update alert configuration
 */
export const updateCoveredCallAlertConfig = async (
    req: Request,
    res: Response
) => {
    try {
        const { instrumentId, ...configData } = req.body;

        const config = await prisma.covered_call_alert_config.upsert({
            where: {
                instrument_id: instrumentId ?? null,
            },
            update: {
                min_otm_percent: configData.minOtmPercent,
                max_otm_percent: configData.maxOtmPercent,
                min_premium_percent: configData.minPremiumPercent,
                max_premium_percent: configData.maxPremiumPercent,
                min_upside_percent: configData.minUpsidePercent,
                max_upside_percent: configData.maxUpsidePercent,
                consecutive_count: configData.consecutiveCount,
                cooldown_minutes: configData.cooldownMinutes,
                is_active: configData.isActive ?? true,
            },
            create: {
                instrument_id: instrumentId || null,
                min_otm_percent: configData.minOtmPercent ?? 4,
                max_otm_percent: configData.maxOtmPercent ?? 5,
                min_premium_percent: configData.minPremiumPercent ?? 2,
                max_premium_percent: configData.maxPremiumPercent ?? 2.5,
                min_upside_percent: configData.minUpsidePercent ?? 6,
                max_upside_percent: configData.maxUpsidePercent ?? 7,
                consecutive_count: configData.consecutiveCount ?? 10,
                cooldown_minutes: configData.cooldownMinutes ?? 60,
                is_active: configData.isActive ?? true,
            },
        });

        res.json({
            success: true,
            data: config,
        });
    } catch (error: any) {
        devError("❌ Failed to update covered call alert config:", error?.message || error);
        res.status(500).json({
            success: false,
            message: "Failed to update covered call alert config",
            ...(process.env.NODE_ENV !== "production" && { error: error?.message }),
        });
    }
};
