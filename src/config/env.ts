import { config } from "dotenv";

export const loadEnv = () => {
  config({ quiet: true, debug: false });

  // Required environment variables
  const requiredEnvVars = [
    "PORT",
    "API_USERNAME",
    "API_PASSWORD",
    "LOGIN_API_URL",
    "DATABASE_URL",
    "EMAIL_USER",
    "EMAIL_PASS",
    "RECEIVER_EMAIL",
    "ACCESS_TOKEN",
    "API_URL_INSTRUMENTS",
    "API_URL_HISTORICAL",
    "DHAN_ACCESS_TOKEN",
    "DHAN_CLIENT_ID",
    "NODE_ENV",
    "GAP_BASELINE_DAYS_MIN",
    "GAP_BASELINE_DAYS_MAX",
    "GAP_ALERT_PERCENT",
    "GAP_ALERT_COOLDOWN",
    "GAP_BASELINE_LOAD_CRON",
    "GAP_HISTORY_CLEANUP_CRON",
    "GAP_HISTORY_RETENTION_DAYS",
    "GAP_ALERT_EMAILS",
    // "GAP_ALERT_SMS_NUMBERS",
    // "SMS_API_URL",
    // "SMS_API_KEY",
    // "SMS_SENDER_ID",
    "AUTH_USERNAME",
    "AUTH_PASSWORD",
    "AUTH_ALLOWED_EMAILS",
    "JWT_SECRET",
    "JWT_EXPIRES_IN",
    "OTP_EXPIRATION_MINUTES",
    "AUTH_OTP_EMAIL",
    "MIN_VOLUME_THRESHOLD",
    "MIN_TIME_DIFF",
    "UPSTOX_API_KEY",
    "UPSTOX_API_SECRET",
    "UPSTOX_REDIRECT_URI",
    "PRISMA_LOG_QUERIES",
    "PRISMA_SLOW_QUERY_MS",
    "COVERED_CALL_ALERT_MIN_OTM",
    "COVERED_CALL_ALERT_MAX_OTM",
    "COVERED_CALL_ALERT_MIN_PREMIUM",
    "COVERED_CALL_ALERT_MAX_PREMIUM",
    "COVERED_CALL_ALERT_MIN_UPSIDE",
    "COVERED_CALL_ALERT_MAX_UPSIDE",
    "COVERED_CALL_ALERT_CONSECUTIVE_COUNT",
    "COVERED_CALL_ALERT_COOLDOWN_MINUTES",
    "COVERED_CALL_ALERT_EMAILS",
  ];

  // Check if all required environment variables are set
  const missingEnvVars = requiredEnvVars.filter(
    (envVar) => !process.env[envVar]
  );

  if (missingEnvVars.length > 0) {
    throw new Error(
      `❌ Missing required environment variables: ${missingEnvVars.join(", ")}`
    );
  }
};
