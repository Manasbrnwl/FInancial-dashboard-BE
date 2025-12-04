import axios from "axios";
import { config } from "dotenv";
import cron from "node-cron";
import { sendEmailNotification } from "../utils/sendEmail";
import { setDhanAccessToken } from "../config/store";

config();

interface TokenData {
  accessToken: string;
  expiryTime: string;
  dhanClientId: string;
}

/**
 * DhanHQ Token Manager
 * Manages automatic token renewal for DhanHQ API access
 *
 * Note: Due to SEBI regulations, DhanHQ access tokens are valid for 24 hours only.
 * This manager automatically renews the token before expiry.
 */
class DhanTokenManager {
  private accessToken: string | null = null;
  private expiryTime: Date | null = null;
  private dhanClientId: string;
  private isInitialized: boolean = false;
  private renewalScheduled: boolean = false;

  constructor() {
    this.dhanClientId = process.env.DHAN_CLIENT_ID || "";
  }

  /**
   * Initialize the token manager with an initial token
   * This token should be generated from DhanHQ web interface
   */
  async initialize(initialToken?: string): Promise<void> {
    try {
      const token = initialToken || process.env.DHAN_ACCESS_TOKEN;

      if (!token) {
        throw new Error(
          "No Dhan access token provided. Please set DHAN_ACCESS_TOKEN in environment variables or pass it to initialize()"
        );
      }

      if (!this.dhanClientId) {
        throw new Error(
          "DHAN_CLIENT_ID is required. Please set it in environment variables"
        );
      }

      console.log("🔑 Initializing DhanHQ token manager...");

      // Set initial token
      this.accessToken = token;
      setDhanAccessToken(token); // Update global store
      // Assume 24 hours expiry for initial token
      this.expiryTime = new Date(Date.now() + 24 * 60 * 60 * 1000);

      // Verify token is valid
      const isValid = await this.verifyToken();

      if (!isValid) {
        console.warn(
          "⚠️ Initial token may be invalid or expired. Attempting renewal..."
        );
        await this.renewToken();
      }

      this.isInitialized = true;

      // Schedule automatic renewal (every 20 hours to be safe)
      this.scheduleAutomaticRenewal();

      console.log(
        "✅ DhanHQ token manager initialized successfully"
      );
    } catch (error: any) {
      console.error("❌ Failed to initialize DhanHQ token manager:", error.message);
      throw error;
    }
  }

  /**
   * Verify if current token is valid
   */
  private async verifyToken(): Promise<boolean> {
    try {
      const response = await axios.get("https://api.dhan.co/v2/profile", {
        headers: {
          "access-token": this.accessToken,
        },
      });

      console.log("✅ DhanHQ token verified successfully");
      return response.status === 200;
    } catch (error: any) {
      console.error("❌ Token verification failed:", error.message);
      return false;
    }
  }

  /**
   * Renew the access token using DhanHQ RenewToken API
   */
  async renewToken(): Promise<void> {
    try {
      console.log("🔄 Renewing DhanHQ access token...");

      const response = await axios.post(
        "https://api.dhan.co/v2/RenewToken",
        {},
        {
          headers: {
            "access-token": this.accessToken,
            "dhanClientId": this.dhanClientId,
            "Content-Type": "application/json",
          },
        }
      );

      if (response.data && response.data.accessToken) {
        this.accessToken = response.data.accessToken;
        setDhanAccessToken(response.data.accessToken); // Update global store
        this.expiryTime = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

        console.log("✅ DhanHQ token renewed successfully");
        console.log(`🕐 Token valid until: ${this.expiryTime.toISOString()}`);

        // Verify renewed token
        const isValid = await this.verifyToken();
        if (!isValid) {
          throw new Error("Renewed token validation failed");
        }

        // Send success notification
        await this.sendNotification(
          "DhanHQ Token Renewed Successfully",
          `Token renewed at ${new Date().toISOString()}. Valid for 24 hours.`
        );
      } else {
        throw new Error("Invalid response from RenewToken API");
      }
    } catch (error: any) {
      console.error("❌ Failed to renew DhanHQ token:", error.message);

      // Send failure notification
      await this.sendNotification(
        "DhanHQ Token Renewal Failed",
        `Failed to renew token: ${error.message}. Please manually generate a new token from DhanHQ web interface.`,
        true
      );

      throw error;
    }
  }

  /**
   * Schedule automatic token renewal every 20 hours
   */
  private scheduleAutomaticRenewal(): void {
    if (this.renewalScheduled) {
      console.log("⏰ Token renewal already scheduled");
      return;
    }

    // Run every day at 3:00 AM to renew token (20 hours after typical 6 AM start)
    cron.schedule("0 3 * * *", async () => {
      console.log("⏰ Scheduled token renewal triggered");
      try {
        await this.renewToken();
      } catch (error: any) {
        console.error("❌ Scheduled token renewal failed:", error.message);
      }
    }, {
      timezone: "Asia/Kolkata",
    });

    this.renewalScheduled = true;
    console.log("⏰ Automatic token renewal scheduled for 3:00 AM daily");
  }

  /**
   * Get current access token
   */
  getAccessToken(): string {
    if (!this.isInitialized) {
      throw new Error(
        "Token manager not initialized. Call initialize() first."
      );
    }

    if (!this.accessToken) {
      throw new Error("No access token available");
    }

    // Check if token is expired or about to expire (within 1 hour)
    if (this.expiryTime && Date.now() > this.expiryTime.getTime() - 60 * 60 * 1000) {
      console.warn("⚠️ Token expiring soon, renewal recommended");
    }

    return this.accessToken;
  }

  /**
   * Check if token manager is initialized
   */
  isReady(): boolean {
    return this.isInitialized && this.accessToken !== null;
  }

  /**
   * Get token expiry information
   */
  getTokenExpiry(): Date | null {
    return this.expiryTime;
  }

  /**
   * Send email notification
   */
  private async sendNotification(
    subject: string,
    message: string,
    isError: boolean = false
  ): Promise<void> {
    try {
      const emailBody = `
        <h1>DhanHQ Token Manager</h1>
        <p>${message}</p>
        <p><strong>Time:</strong> ${new Date().toISOString()}</p>
        ${isError ? '<p style="color: red;">⚠️ <strong>Action Required:</strong> Please check the application logs and regenerate token if needed.</p>' : ''}
      `;

      await sendEmailNotification(
        process.env.RECEIVER_EMAIL || "tech@anfy.in",
        subject,
        message,
        emailBody
      );
    } catch (error: any) {
      console.error("❌ Failed to send notification email:", error.message);
    }
  }

  /**
   * Manually trigger token renewal (for testing or emergency use)
   */
  async forceRenewal(): Promise<void> {
    console.log("🔧 Manual token renewal triggered");
    await this.renewToken();
  }
}

// Singleton instance
export const dhanTokenManager = new DhanTokenManager();
