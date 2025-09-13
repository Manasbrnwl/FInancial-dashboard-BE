import { config } from "dotenv";

export const loadEnv = () => {
  config();

  // Required environment variables
  const requiredEnvVars = [
    "PORT",
    "API_USERNAME",
    "API_PASSWORD",
    "LOGIN_API_URL",
    "EMAIL_USER",
    "EMAIL_PASS",
    "RECEIVER_EMAIL",
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
