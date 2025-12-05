import { PrismaClient } from "@prisma/client";
import { socketIOService } from "./socketioService";
import { getGapBaseline } from "../cache/gapAverageCache";
import { loadEnv } from "../config/env";
import { sendEmailNotification } from "../utils/sendEmail";
import { sendSmsNotification } from "../utils/sendSms";

loadEnv();

const prisma = new PrismaClient();

interface GapData {
  instrumentId: number;
  instrumentName: string;
  gap_1: number | null;
  gap_2: number | null;
  price_1?: number;
  price_2?: number;
  price_3?: number;
  timestamp?: string | Date;
  timeSlot?: string;
}

interface AlertConfig {
  percentThreshold: number;
  cooldownMinutes: number;
}

interface ProcessOptions {
  percentThreshold?: number;
  cooldownMinutes?: number;
}

const recentAlerts = new Map<string, Date>();
const configCache = new Map<string | number, AlertConfig>();

const DEFAULT_CONFIG: AlertConfig = {
  percentThreshold: toNumber(process.env.GAP_ALERT_PERCENT, 15),
  cooldownMinutes: toNumber(process.env.GAP_ALERT_COOLDOWN, 30),
};

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

const ALERT_EMAIL_RECIPIENTS = parseCsv(
  process.env.GAP_ALERT_EMAILS || process.env.RECEIVER_EMAIL
);
const ALERT_SMS_RECIPIENTS = parseCsv(process.env.GAP_ALERT_SMS_NUMBERS);

function toIST(date: Date): Date {
  const utc = date.getTime() + date.getTimezoneOffset() * 60000;
  return new Date(utc + 5.5 * 60 * 60000);
}

function formatTimeSlot(date: Date): string {
  // const ist = toIST(date);
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

function computeDeviationPercent(
  current: number | null,
  baseline: number | null
): number {
  if (current === null || baseline === null || baseline === 0) return 0;
  return Math.abs((current - baseline) / baseline) * 100;
}

async function getAlertConfig(instrumentId?: number): Promise<AlertConfig> {
  if (instrumentId && configCache.has(instrumentId)) {
    return configCache.get(instrumentId)!;
  }

  let globalConfig = configCache.get("global");

  if (!globalConfig) {
    const dbGlobal = await prisma.gap_alert_config.findFirst({
      where: { instrument_id: null, is_active: true },
    });

    globalConfig = {
      percentThreshold:
        dbGlobal?.percent_threshold ?? DEFAULT_CONFIG.percentThreshold,
      cooldownMinutes:
        dbGlobal?.cooldown_minutes ?? DEFAULT_CONFIG.cooldownMinutes,
    };

    configCache.set("global", globalConfig);
  }

  if (!instrumentId) return globalConfig;

  const specificConfig = await prisma.gap_alert_config.findFirst({
    where: { instrument_id: instrumentId, is_active: true },
  });

  const finalConfig = specificConfig
    ? {
      percentThreshold:
        specificConfig.percent_threshold ?? globalConfig.percentThreshold,
      cooldownMinutes:
        specificConfig.cooldown_minutes ?? globalConfig.cooldownMinutes,
    }
    : globalConfig;

  configCache.set(instrumentId, finalConfig);
  return finalConfig;
}

async function triggerAlert({
  instrumentId,
  instrumentName,
  alertType,
  timeSlot,
  currentValue,
  baselineValue,
  deviationPercent,
  baselineDate,
}: {
  instrumentId: number;
  instrumentName: string;
  alertType: "gap_1" | "gap_2";
  timeSlot: string;
  currentValue: number;
  baselineValue: number | null;
  deviationPercent: number;
  baselineDate: Date | null;
}): Promise<void> {
  const alertKey = `${instrumentId}-${alertType}`;
  const existing = recentAlerts.get(alertKey);

  const config = await getAlertConfig(instrumentId);
  if (existing) {
    const minutesSince = (Date.now() - existing.getTime()) / 60000;
    if (minutesSince < config.cooldownMinutes) {
      return;
    }
  }

  const payload = {
    instrumentId,
    instrumentName,
    alertType,
    timeSlot,
    currentValue,
    baselineValue,
    deviationPercent: Math.round(deviationPercent * 100) / 100,
    baselineDate,
    triggeredAt: new Date().toISOString(),
  };

  const io = socketIOService.getIO();
  if (io) {
    io.emit("gap-alert", payload);
  }

  await prisma.gap_alerts.create({
    data: {
      instrument_id: instrumentId,
      instrument_name: instrumentName,
      time_slot: timeSlot,
      alert_type: alertType,
      current_value: currentValue,
      avg_value: baselineValue ?? 0,
      deviation_percent: deviationPercent,
    },
  });

  recentAlerts.set(alertKey, new Date());
  console.log(
    `?? Gap alert: ${instrumentName} ${alertType} deviation ${payload.deviationPercent}% (slot ${timeSlot})`
  );

  //   const subject = `Gap alert | ${instrumentName} | ${alertType} | ${timeSlot}`;
  //   const text = `Gap alert for ${instrumentName}
  // Type: ${alertType}
  // Slot: ${timeSlot}
  // Current: ${currentValue}
  // Baseline: ${baselineValue ?? "n/a"}
  // Deviation: ${payload.deviationPercent}%
  // Baseline date: ${baselineDate?.toISOString().slice(0, 10) ?? "n/a"}`;
  // const html = `
  //   <h3>Gap alert for ${instrumentName}</h3>
  //   <ul>
  //     <li><strong>Type:</strong> ${alertType}</li>
  //     <li><strong>Slot:</strong> ${timeSlot}</li>
  //     <li><strong>Current:</strong> ${currentValue}</li>
  //     <li><strong>Baseline:</strong> ${baselineValue ?? "n/a"}</li>
  //     <li><strong>Deviation:</strong> ${payload.deviationPercent}%</li>
  //     <li><strong>Baseline date:</strong> ${
  //       baselineDate?.toISOString().slice(0, 10) ?? "n/a"
  //     }</li>
  //   </ul>
  //   <p>Triggered at ${payload.triggeredAt}</p>
  // `;

  // if (ALERT_EMAIL_RECIPIENTS.length) {
  //   Promise.allSettled(
  //     ALERT_EMAIL_RECIPIENTS.map((email) =>
  //       sendEmailNotification(email, subject, text, html)
  //     )
  //   ).catch((err) =>
  //     console.error("? Failed to send gap alert emails:", err?.message || err)
  //   );
  // }

  const smsMessage = `Gap alert ${instrumentName} ${alertType} ${timeSlot}: cur ${currentValue}, base ${baselineValue ?? "n/a"
    }, dev ${payload.deviationPercent}%`;
  if (ALERT_SMS_RECIPIENTS.length) {
    Promise.allSettled(
      ALERT_SMS_RECIPIENTS.map((phone) =>
        sendSmsNotification(phone, smsMessage)
      )
    ).catch((err) =>
      console.error("? Failed to send gap alert SMS:", err?.message || err)
    );
  }
}

async function storeGapPoint(
  gap: GapData,
  timeSlot: string,
  dateOnly: Date
): Promise<void> {
  await prisma.gap_time_series.upsert({
    where: {
      instrument_id_date_time_slot: {
        instrument_id: gap.instrumentId,
        date: dateOnly,
        time_slot: timeSlot,
      },
    },
    update: {
      gap_1: { set: gap.gap_1 as any },
      gap_2: { set: gap.gap_2 as any },
      price_1: gap.price_1 ?? null,
      price_2: gap.price_2 ?? null,
      price_3: gap.price_3 ?? null,
    },
    create: {
      instrument_id: gap.instrumentId,
      date: dateOnly,
      time_slot: timeSlot,
      gap_1: gap.gap_1 as any,
      gap_2: gap.gap_2 as any,
      price_1: gap.price_1 ?? null,
      price_2: gap.price_2 ?? null,
      price_3: gap.price_3 ?? null,
    },
  });
}

/**
 * Core processor: store current gaps, compare against cached baselines, emit + persist alerts.
 */
export async function processGapData(
  gaps: GapData[],
  options: ProcessOptions = {}
): Promise<void> {
  const now = new Date();
  const percentThresholdOverride = options.percentThreshold;
  const cooldownOverride = options.cooldownMinutes;

  for (const gap of gaps) {
    try {
      const timestampDate = getTimestampDate(gap.timestamp);
      const timeSlot = gap.timeSlot || formatTimeSlot(timestampDate);
      const dateOnly = getISTDateOnly(timestampDate);
      const baseline = getGapBaseline(gap.instrumentId);
      const config = await getAlertConfig(gap.instrumentId);

      await storeGapPoint(gap, timeSlot, dateOnly);

      if (!baseline) {
        continue;
      }

      const percentThreshold =
        percentThresholdOverride ?? config.percentThreshold;

      // Pass nulls safely to computeDeviationPercent
      const deviation1 = computeDeviationPercent(
        gap.gap_1,
        baseline.baselineGap1
      );
      const deviation2 = computeDeviationPercent(
        gap.gap_2,
        baseline.baselineGap2
      );

      if (gap.gap_1 !== null && deviation1 >= percentThreshold) {
        await triggerAlert({
          instrumentId: gap.instrumentId,
          instrumentName: gap.instrumentName,
          alertType: "gap_1",
          timeSlot,
          currentValue: gap.gap_1,
          baselineValue: baseline.baselineGap1,
          deviationPercent: deviation1,
          baselineDate: baseline.baselineDate ?? now,
        });
      }

      if (gap.gap_2 !== null && deviation2 >= percentThreshold) {
        await triggerAlert({
          instrumentId: gap.instrumentId,
          instrumentName: gap.instrumentName,
          alertType: "gap_2",
          timeSlot,
          currentValue: gap.gap_2,
          baselineValue: baseline.baselineGap2,
          deviationPercent: deviation2,
          baselineDate: baseline.baselineDate ?? now,
        });
      }

      if (cooldownOverride ?? config.cooldownMinutes !== undefined) {
        configCache.set(gap.instrumentId, {
          ...config,
          cooldownMinutes: cooldownOverride ?? config.cooldownMinutes,
        });
      }
    } catch (error: any) {
      console.error(
        `? Failed to process gap data for ${gap.instrumentName}:`,
        error.message
      );
    }
  }
}

export function clearAlertCaches(): void {
  recentAlerts.clear();
  configCache.clear();
}
