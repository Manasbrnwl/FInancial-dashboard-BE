import axios from "axios";
import { devLog, devError } from "./errorLogger";

/**
 * Send notification via ntfy.sh
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

  try {

    await axios.post(`${baseUrl}/${topic}`, message, {});
    devLog(`[NTFY] Notification sent to topic: ${topic}`);
    return true;
  } catch (error: any) {
    const errorMsg = error.response?.data || error.message || "Unknown error";
    devError(`Failed to send ntfy notification: ${errorMsg}`);
    return false;
  }
};
