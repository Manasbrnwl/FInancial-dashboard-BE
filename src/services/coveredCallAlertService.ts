import { PrismaClient } from "@prisma/client";
import { socketIOService } from "./socketioService";
import { loadEnv } from "../config/env";
import { sendEmailNotification } from "../utils/sendEmail";
import { devLog, devWarn, devError } from "../utils/errorLogger";

loadEnv();

const prisma = new PrismaClient();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface CoveredCallCandidate {
    instrumentId: number;
    instrumentName: string;
    symbol: string;
    strike: number;
    optionType: string;
    expiryDate: Date;
    underlyingPrice: number;
    premium: number;
    timestamp?: string | Date;
    timeSlot?: string;
}

interface AlertConfig {
    minOtmPercent: number;
    maxOtmPercent: number;
    minPremiumPercent: number;
    maxPremiumPercent: number;
    minUpsidePercent: number;
    maxUpsidePercent: number;
    consecutiveCount: number;
    cooldownMinutes: number;
}

interface ProcessOptions {
    suppressAlerts?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

/** Tracks consecutive criteria matches per option symbol */
const consecutiveMatches = new Map<string, number>();

/** Tracks recent alerts for cooldown */
const recentAlerts = new Map<string, Date>();

/** Config cache */
const configCache = new Map<string | number, AlertConfig>();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function toNumber(input: string | undefined, fallback: number): number {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCsv(value?: string): string[] {
    if (!value) return [];
    return value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
}

const DEFAULT_CONFIG: AlertConfig = {
    minOtmPercent: toNumber(process.env.COVERED_CALL_ALERT_MIN_OTM, 4),
    maxOtmPercent: toNumber(process.env.COVERED_CALL_ALERT_MAX_OTM, 5),
    minPremiumPercent: toNumber(process.env.COVERED_CALL_ALERT_MIN_PREMIUM, 2),
    maxPremiumPercent: toNumber(process.env.COVERED_CALL_ALERT_MAX_PREMIUM, 2.5),
    minUpsidePercent: toNumber(process.env.COVERED_CALL_ALERT_MIN_UPSIDE, 6),
    maxUpsidePercent: toNumber(process.env.COVERED_CALL_ALERT_MAX_UPSIDE, 7),
    consecutiveCount: toNumber(process.env.COVERED_CALL_ALERT_CONSECUTIVE_COUNT, 10),
    cooldownMinutes: toNumber(process.env.COVERED_CALL_ALERT_COOLDOWN_MINUTES, 60),
};

const ALERT_EMAIL_RECIPIENTS = parseCsv(
    process.env.COVERED_CALL_ALERT_EMAILS || process.env.RECEIVER_EMAIL
);

function toIST(date: Date): Date {
    const utc = date.getTime() + date.getTimezoneOffset() * 60000;
    return new Date(utc + 5.5 * 60 * 60000);
}

function formatTimeSlot(date: Date): string {
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
}

function getISTDateOnly(date: Date): Date {
    const ist = toIST(date);
    return new Date(Date.UTC(ist.getFullYear(), ist.getMonth(), ist.getDate()));
}

function getTimestampDate(timestamp?: string | Date): Date {
    if (!timestamp) return new Date();
    return timestamp instanceof Date ? timestamp : new Date(timestamp);
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

async function preloadConfigs(): Promise<void> {
    const configs = await prisma.covered_call_alert_config.findMany({
        where: { is_active: true },
    });

    // Clear cache first
    configCache.clear();

    // Process global first
    const dbGlobal = configs.find((c) => c.instrument_id === null);
    const globalConfig: AlertConfig = {
        minOtmPercent: dbGlobal?.min_otm_percent ?? DEFAULT_CONFIG.minOtmPercent,
        maxOtmPercent: dbGlobal?.max_otm_percent ?? DEFAULT_CONFIG.maxOtmPercent,
        minPremiumPercent: dbGlobal?.min_premium_percent ?? DEFAULT_CONFIG.minPremiumPercent,
        maxPremiumPercent: dbGlobal?.max_premium_percent ?? DEFAULT_CONFIG.maxPremiumPercent,
        minUpsidePercent: dbGlobal?.min_upside_percent ?? DEFAULT_CONFIG.minUpsidePercent,
        maxUpsidePercent: dbGlobal?.max_upside_percent ?? DEFAULT_CONFIG.maxUpsidePercent,
        consecutiveCount: dbGlobal?.consecutive_count ?? DEFAULT_CONFIG.consecutiveCount,
        cooldownMinutes: dbGlobal?.cooldown_minutes ?? DEFAULT_CONFIG.cooldownMinutes,
    };
    configCache.set("global", globalConfig);

    // Then process specific configs
    for (const cfg of configs) {
        if (cfg.instrument_id !== null) {
            configCache.set(cfg.instrument_id, {
                minOtmPercent: cfg.min_otm_percent ?? globalConfig.minOtmPercent,
                maxOtmPercent: cfg.max_otm_percent ?? globalConfig.maxOtmPercent,
                minPremiumPercent: cfg.min_premium_percent ?? globalConfig.minPremiumPercent,
                maxPremiumPercent: cfg.max_premium_percent ?? globalConfig.maxPremiumPercent,
                minUpsidePercent: cfg.min_upside_percent ?? globalConfig.minUpsidePercent,
                maxUpsidePercent: cfg.max_upside_percent ?? globalConfig.maxUpsidePercent,
                consecutiveCount: cfg.consecutive_count ?? globalConfig.consecutiveCount,
                cooldownMinutes: cfg.cooldown_minutes ?? globalConfig.cooldownMinutes,
            });
        }
    }
}

async function getAlertConfig(instrumentId?: number): Promise<AlertConfig> {
    if (instrumentId && configCache.has(instrumentId)) {
        return configCache.get(instrumentId)!;
    }

    let globalConfig = configCache.get("global");

    if (!globalConfig) {
        // Fallback if not preloaded (should not happen with processCoveredCallData)
        const dbGlobal = await prisma.covered_call_alert_config.findFirst({
            where: { instrument_id: null, is_active: true },
        });

        globalConfig = {
            minOtmPercent: dbGlobal?.min_otm_percent ?? DEFAULT_CONFIG.minOtmPercent,
            maxOtmPercent: dbGlobal?.max_otm_percent ?? DEFAULT_CONFIG.maxOtmPercent,
            minPremiumPercent: dbGlobal?.min_premium_percent ?? DEFAULT_CONFIG.minPremiumPercent,
            maxPremiumPercent: dbGlobal?.max_premium_percent ?? DEFAULT_CONFIG.maxPremiumPercent,
            minUpsidePercent: dbGlobal?.min_upside_percent ?? DEFAULT_CONFIG.minUpsidePercent,
            maxUpsidePercent: dbGlobal?.max_upside_percent ?? DEFAULT_CONFIG.maxUpsidePercent,
            consecutiveCount: dbGlobal?.consecutive_count ?? DEFAULT_CONFIG.consecutiveCount,
            cooldownMinutes: dbGlobal?.cooldown_minutes ?? DEFAULT_CONFIG.cooldownMinutes,
        };

        configCache.set("global", globalConfig);
    }

    if (!instrumentId) return globalConfig;

    const specificConfig = await prisma.covered_call_alert_config.findFirst({
        where: { instrument_id: instrumentId, is_active: true },
    });

    const finalConfig = specificConfig
        ? {
            minOtmPercent: specificConfig.min_otm_percent ?? globalConfig.minOtmPercent,
            maxOtmPercent: specificConfig.max_otm_percent ?? globalConfig.maxOtmPercent,
            minPremiumPercent: specificConfig.min_premium_percent ?? globalConfig.minPremiumPercent,
            maxPremiumPercent: specificConfig.max_premium_percent ?? globalConfig.maxPremiumPercent,
            minUpsidePercent: specificConfig.min_upside_percent ?? globalConfig.minUpsidePercent,
            maxUpsidePercent: specificConfig.max_upside_percent ?? globalConfig.maxUpsidePercent,
            consecutiveCount: specificConfig.consecutive_count ?? globalConfig.consecutiveCount,
            cooldownMinutes: specificConfig.cooldown_minutes ?? globalConfig.cooldownMinutes,
        }
        : globalConfig;

    configCache.set(instrumentId, finalConfig);
    return finalConfig;
}

// ─────────────────────────────────────────────────────────────────────────────
// Criteria Checking
// ─────────────────────────────────────────────────────────────────────────────

interface CriteriaResult {
    matches: boolean;
    otmPercent: number;
    premiumPercent: number;
    maxUpside: number;
}

/** Alert payload for collecting triggered alerts */
interface AlertPayload {
    instrumentId: number;
    instrumentName: string;
    symbol: string;
    strike: number;
    optionType: string;
    expiryDate: string;
    timeSlot: string;
    underlyingPrice: string;
    premium: string;
    otmPercent: number;
    premiumPercent: number;
    maxUpside: number;
    triggeredAt: string;
}

function checkCriteria(
    candidate: CoveredCallCandidate,
    config: AlertConfig
): CriteriaResult {
    const { underlyingPrice, strike, premium } = candidate;

    // OTM % = ((strike - underlyingPrice) / underlyingPrice) * 100
    const otmPercent = ((strike - underlyingPrice) / underlyingPrice) * 100;

    // Monthly Premium % = (premium / underlyingPrice) * 100
    // Note: This assumes the premium is already monthly; adjust if needed
    const premiumPercent = (premium / underlyingPrice) * 100;

    // Max Upside = strike - underlyingPrice + premium
    // As % of underlyingPrice
    const maxUpsideValue = strike - underlyingPrice + premium;
    const maxUpside = (maxUpsideValue / underlyingPrice) * 100;

    // Check if within ranges
    const otmInRange = otmPercent >= config.minOtmPercent && otmPercent <= config.maxOtmPercent;
    const premiumInRange = premiumPercent >= config.minPremiumPercent && premiumPercent <= config.maxPremiumPercent;
    const upsideInRange = maxUpside >= config.minUpsidePercent && maxUpside <= config.maxUpsidePercent;

    return {
        matches: otmInRange && premiumInRange && upsideInRange,
        otmPercent: Math.round(otmPercent * 100) / 100,
        premiumPercent: Math.round(premiumPercent * 100) / 100,
        maxUpside: Math.round(maxUpside * 100) / 100,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Alert Trigger
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process a single alert - persist to DB, emit via SocketIO, return payload for consolidated email
 */
export async function triggerCoveredCallAlert(
    candidate: CoveredCallCandidate,
    criteriaResult: CriteriaResult,
    timeSlot: string
): Promise<AlertPayload | null> {
    const alertKey = `${candidate.symbol}`;
    const existing = recentAlerts.get(alertKey);

    const config = await getAlertConfig(candidate.instrumentId);
    if (existing) {
        const minutesSince = (Date.now() - existing.getTime()) / 60000;
        if (minutesSince < config.cooldownMinutes) {
            return null;
        }
    }

    const payload: AlertPayload = {
        instrumentId: candidate.instrumentId,
        instrumentName: candidate.instrumentName,
        symbol: candidate.symbol,
        strike: candidate.strike,
        optionType: candidate.optionType,
        expiryDate: candidate.expiryDate.toISOString().slice(0, 10),
        timeSlot,
        underlyingPrice: candidate.underlyingPrice.toFixed(2),
        premium: candidate.premium.toFixed(2),
        otmPercent: criteriaResult.otmPercent,
        premiumPercent: criteriaResult.premiumPercent,
        maxUpside: criteriaResult.maxUpside,
        triggeredAt: new Date().toISOString(),
    };

    // Emit via SocketIO
    const io = socketIOService.getIO();
    if (io) {
        io.emit("covered-call-alert", payload);
    }

    // Persist to database
    await prisma.covered_call_alerts.create({
        data: {
            instrument_id: candidate.instrumentId,
            instrument_name: candidate.instrumentName,
            symbol: candidate.symbol,
            strike: candidate.strike,
            option_type: candidate.optionType,
            expiry_date: candidate.expiryDate,
            time_slot: timeSlot,
            underlying_price: candidate.underlyingPrice,
            premium: candidate.premium,
            otm_percent: criteriaResult.otmPercent,
            premium_percent: criteriaResult.premiumPercent,
            max_upside: criteriaResult.maxUpside,
        },
    });

    recentAlerts.set(alertKey, new Date());

    devLog(
        `📢 Covered Call Alert: ${candidate.symbol} | OTM ${criteriaResult.otmPercent}% | Premium ${criteriaResult.premiumPercent}% | Upside ${criteriaResult.maxUpside}%`
    );

    return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// Consolidated Email
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a single consolidated email with all triggered alerts
 */
async function sendConsolidatedAlertEmail(alerts: AlertPayload[]): Promise<void> {
    if (alerts.length === 0 || ALERT_EMAIL_RECIPIENTS.length === 0) {
        return;
    }

    const now = toIST(new Date());
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19);

    const subject = `📢 Covered Call Alerts (${alerts.length}) | ${dateStr} ${timeStr} IST`;

    // Build text version
    const text = `Covered Call Alerts Summary\n\nTotal Alerts: ${alerts.length}\nTime: ${dateStr} ${timeStr} IST\n\n` +
        alerts.map((a, i) =>
            `${i + 1}. ${a.symbol}\n` +
            `   Underlying: ${a.instrumentName} @ ₹${a.underlyingPrice}\n` +
            `   Strike: ₹${a.strike} | Premium: ₹${a.premium}\n` +
            `   OTM: ${a.otmPercent}% | Premium %: ${a.premiumPercent}% | Max Upside: ${a.maxUpside}%\n`
        ).join("\n");

    // Build HTML table
    const alertRows = alerts
        .map((alert) => `
            <tr>
              <td style="padding: 8px; border: 1px solid #ddd;">${alert.instrumentName}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${alert.symbol}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${alert.expiryDate}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">₹${alert.underlyingPrice}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">₹${alert.strike}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">₹${alert.premium}</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${alert.otmPercent.toFixed(2)}%</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${alert.premiumPercent.toFixed(2)}%</td>
              <td style="padding: 8px; border: 1px solid #ddd;">${alert.maxUpside.toFixed(2)}%</td>
            </tr>
        `)
        .join("");

    const html = `
    <h2>📢 Covered Call Alerts Summary</h2>
    <p><strong>Total Alerts:</strong> ${alerts.length}</p>
    <p><strong>Generated at:</strong> ${dateStr} ${timeStr} IST</p>
    <br/>
    <table style="border-collapse: collapse; width: 100%; font-family: Arial, sans-serif;">
      <thead>
        <tr style="background-color: #4CAF50; color: white;">
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Underlying</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Symbol</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Expiry</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">CMP</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Strike</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Premium</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">OTM %</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Premium %</th>
          <th style="padding: 10px; border: 1px solid #ddd; text-align: left;">Max Upside %</th>
        </tr>
      </thead>
      <tbody>
        ${alertRows}
      </tbody>
    </table>
    <br/>
    <p style="color: #666; font-size: 12px;">This is an automated alert from the Covered Call Alert System.</p>
  `;

    devLog(`📧 Sending consolidated email with ${alerts.length} alerts to ${ALERT_EMAIL_RECIPIENTS.length} recipients...`);

    try {
        await Promise.allSettled(
            ALERT_EMAIL_RECIPIENTS.map((email) =>
                sendEmailNotification(email, subject, text, html)
            )
        );
        devLog(`✅ Consolidated alert email sent successfully`);
    } catch (err: any) {
        devError("❌ Failed to send consolidated alert email:", err?.message || err);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Processor
// ─────────────────────────────────────────────────────────────────────────────

const PROCESS_BATCH_SIZE = 10; // Reduced batch size to avoid connection pool exhaustion

/**
 * Process covered call candidates every 5 minutes.
 * Tracks consecutive matches and triggers alerts after reaching threshold.
 */
export async function processCoveredCallData(
    candidates: CoveredCallCandidate[],
    options: ProcessOptions = {}
): Promise<void> {
    const suppressAlerts = options.suppressAlerts || false;

    // Pre-load all configurations into cache once before parallel processing 
    // This avoids repeated DB queries per candidate and prevents connection exhaustion
    await preloadConfigs();

    // Collect all triggered alerts for consolidated email
    const triggeredAlerts: AlertPayload[] = [];

    // Process candidates in batches to avoid exhausting the connection pool
    for (let i = 0; i < candidates.length; i += PROCESS_BATCH_SIZE) {
        const batch = candidates.slice(i, i + PROCESS_BATCH_SIZE);

        const batchResults = await Promise.all(
            batch.map(async (candidate): Promise<AlertPayload | null> => {
                try {
                    const timestampDate = getTimestampDate(candidate.timestamp);
                    const timeSlot = candidate.timeSlot || formatTimeSlot(timestampDate);

                    // Use pre-loaded global config (already cached), specific configs will be fetched if needed
                    const config = await getAlertConfig(candidate.instrumentId);

                    const criteriaResult = checkCriteria(candidate, config);
                    const symbolKey = candidate.symbol;

                    if (criteriaResult.matches) {
                        // Increment consecutive count
                        const currentCount = consecutiveMatches.get(symbolKey) || 0;
                        const newCount = currentCount + 1;
                        consecutiveMatches.set(symbolKey, newCount);

                        // Check if threshold reached
                        if (newCount >= config.consecutiveCount && !suppressAlerts) {
                            const alert = await triggerCoveredCallAlert(candidate, criteriaResult, timeSlot);
                            // Reset count after alert
                            consecutiveMatches.delete(symbolKey);
                            return alert;
                        }
                    } else {
                        // Reset count if criteria not met
                        if (consecutiveMatches.has(symbolKey)) {
                            devLog(`📉 ${candidate.symbol}: Criteria not met, resetting count`);
                            consecutiveMatches.delete(symbolKey);
                        }
                    }
                    return null;
                } catch (error: any) {
                    devError(
                        `❌ Failed to process covered call for ${candidate.symbol}:`,
                        error.message
                    );
                    return null;
                }
            })
        );

        // Collect non-null alerts from this batch
        triggeredAlerts.push(...batchResults.filter((a): a is AlertPayload => a !== null));
    }

    // Send one consolidated email with all triggered alerts
    if (triggeredAlerts.length > 0) {
        await sendConsolidatedAlertEmail(triggeredAlerts);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

export function clearCoveredCallAlertCaches(): void {
    consecutiveMatches.clear();
    recentAlerts.clear();
    configCache.clear();
}

export function getConsecutiveMatchCount(symbol: string): number {
    return consecutiveMatches.get(symbol) || 0;
}
