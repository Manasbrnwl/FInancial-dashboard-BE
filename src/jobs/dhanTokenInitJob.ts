import { dhanTokenManager } from "../services/dhanTokenManager";
import { loadEnv } from "../config/env";
import { devLog, devError, prodError } from "../utils/errorLogger";

loadEnv();

/**
 * Initialize DhanHQ token manager on application startup
 * This must be called before any BSE equity data operations
 */
export async function initializeDhanToken(): Promise<void> {
  try {

    const initialToken = process.env.DHAN_ACCESS_TOKEN;

    if (!initialToken) {
      devError(
        "❌ DHAN_ACCESS_TOKEN not found in environment variables"
      );
      prodError("DHAN_ACCESS_TOKEN not found");
      throw new Error(
        "DHAN_ACCESS_TOKEN is required. Please set it in your .env file."
      );
    }

    if (!process.env.DHAN_CLIENT_ID) {
      devError(
        "❌ DHAN_CLIENT_ID not found in environment variables"
      );
      prodError("DHAN_CLIENT_ID not found");
      throw new Error(
        "DHAN_CLIENT_ID is required. Please set it in your .env file."
      );
    }

    // Initialize token manager with the initial token
    await dhanTokenManager.initialize(initialToken);

    devLog("✅ DhanHQ token manager initialized successfully");
  } catch (error: any) {
    devError(
      "❌ Failed to initialize DhanHQ token manager:",
      error.message
    );
    prodError("Failed to initialize DhanHQ token manager");
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
