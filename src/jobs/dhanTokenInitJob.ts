import { dhanTokenManager } from "../services/dhanTokenManager";
import { loadEnv } from "../config/env";

loadEnv();

/**
 * Initialize DhanHQ token manager on application startup
 * This must be called before any BSE equity data operations
 */
export async function initializeDhanToken(): Promise<void> {
  try {

    const initialToken = process.env.DHAN_ACCESS_TOKEN;

    if (!initialToken) {
      console.error(
        "❌ DHAN_ACCESS_TOKEN not found in environment variables"
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
  } catch (error: any) {
    console.error(
      "❌ Failed to initialize DhanHQ token manager:",
      error.message
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
