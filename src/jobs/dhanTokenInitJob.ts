import { dhanTokenManager } from "../services/dhanTokenManager";
import { loadEnv } from "../config/env";

loadEnv();

/**
 * Initialize DhanHQ token manager on application startup
 * This must be called before any BSE equity data operations
 */
export async function initializeDhanToken(): Promise<void> {
  try {
    console.log("🔑 Initializing DhanHQ token manager...");

    const initialToken = process.env.DHAN_ACCESS_TOKEN;

    if (!initialToken) {
      console.error(
        "❌ DHAN_ACCESS_TOKEN not found in environment variables"
      );
      console.log(
        "ℹ️ To generate a token, visit: https://web.dhan.co"
      );
      console.log(
        "   Navigate to Profile > Access DhanHQ APIs > Generate Token"
      );
      throw new Error(
        "DHAN_ACCESS_TOKEN is required. Please set it in your .env file."
      );
    }

    if (!process.env.DHAN_CLIENT_ID) {
      console.error(
        "❌ DHAN_CLIENT_ID not found in environment variables"
      );
      throw new Error(
        "DHAN_CLIENT_ID is required. Please set it in your .env file."
      );
    }

    // Initialize token manager with the initial token
    await dhanTokenManager.initialize(initialToken);

    console.log("✅ DhanHQ token manager initialized successfully");
    console.log(
      `🕐 Token expires at: ${dhanTokenManager.getTokenExpiry()?.toISOString()}`
    );
  } catch (error: any) {
    console.error(
      "❌ Failed to initialize DhanHQ token manager:",
      error.message
    );
    console.log(
      "\n⚠️ BSE equity data operations will not work until this is resolved."
    );
    throw error;
  }
}

/**
 * Check if Dhan token manager is ready
 */
export function isDhanTokenReady(): boolean {
  return dhanTokenManager.isReady();
}

/**
 * Get Dhan token manager instance (for manual operations)
 */
export function getDhanTokenManager() {
  return dhanTokenManager;
}
