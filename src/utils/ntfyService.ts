import axios from "axios";
import { devLog, devError } from "./errorLogger";

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = [1000, 3000]; // backoff before attempt 2 and attempt 3

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send notification via ntfy.sh
 *
 * This is currently the only alert channel that actually reaches anyone --
 * email alerts are disabled in production (DISABLE_ALERT_EMAILS=true) -- so a
 * single failed POST here means an alert (e.g. "Upstox token expired") is
 * silently lost with nothing else to catch it. Confirmed this happened during
 * the 2026-08-12/13 outage: ntfy failed with a transient error at the exact
 * moment that mattered, and nobody noticed the pipeline was down for 2 days.
 * Retrying with backoff before giving up makes that much less likely to
 * recur for the kind of brief blip seen there.
 *
 * @param {string} message - The message to send
 * @param {string} title - Optional title for the notification
 * @param {string} priority - Optional priority (1-5 or min, low, default, high, urgent)
 * @returns {Promise<boolean>} - true when notification is sent
 */
export const sendNtfyNotification = async (
  message: string,
  title: string = "Finance Dashboard Alert",
  priority: string = "default"
): Promise<boolean> => {
  const topic = process.env.NTFY_TOPIC || 'anfy-sms';
  const baseUrl = process.env.NTFY_URL || "https://ntfy.sh";

  if (!topic) {
    devLog("[NTFY] No NTFY_TOPIC configured. Skipping notification.");
    return false;
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await axios.post(`${baseUrl}/${topic}`, message, {});
      devLog(`[NTFY] Notification sent to topic: ${topic}${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
      return true;
    } catch (error: any) {
      const errorMsg = error.response?.data || error.message || "Unknown error";
      if (attempt < MAX_ATTEMPTS) {
        devError(`[NTFY] Attempt ${attempt}/${MAX_ATTEMPTS} failed (${errorMsg}), retrying...`);
        await sleep(RETRY_DELAY_MS[attempt - 1]);
      } else {
        devError(`[NTFY] All ${MAX_ATTEMPTS} attempts failed, giving up: ${errorMsg}`);
      }
    }
  }
  return false;
};
