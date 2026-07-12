import { config } from "dotenv";

export const loadEnv = () => {
  config({ quiet: true, debug: false });

  // Required environment variables
  const requiredEnvVars = [
    "PORT",
    "DATABASE_URL",
    "NODE_ENV",
    "BREVO_API_KEY",
    "BREVO_SENDER_EMAIL",
    "FRONTEND_URL",
    "JWT_SECRET",
    "JWT_EXPIRES_IN",
    "OTP_EXPIRATION_MINUTES",
    "UPSTOX_API_KEY",
    "UPSTOX_API_SECRET",
    "UPSTOX_REDIRECT_URI",
    "GAP_BASELINE_DAYS_MIN",
    "GAP_BASELINE_DAYS_MAX",
    "GAP_ALERT_PERCENT",
    "GAP_ALERT_COOLDOWN",
    "GAP_ALERT_EMAILS",
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
