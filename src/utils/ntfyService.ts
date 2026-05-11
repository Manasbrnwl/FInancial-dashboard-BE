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
    // ntfy headers (like Title) don't support non-ASCII characters (like emojis)
    const sanitizedTitle = title.replace(/[^\x00-\x7F]/g, "").trim();

    await axios.post(`${baseUrl}/${topic}`, message, {
      headers: {
        "Content-Type": "text/plain",
        "Title": sanitizedTitle || "Alert",
        "Priority": priority,
      },
    });
    devLog(`[NTFY] Notification sent to topic: ${topic}`);
    return true;
  } catch (error: any) {
    devError("Failed to send ntfy notification:", error.message);
    return false;
  }
};
