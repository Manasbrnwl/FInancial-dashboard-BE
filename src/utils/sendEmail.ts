import axios from "axios";
import dotenv from "dotenv";
import { devError, devLog, prodError } from "./errorLogger";

dotenv.config();

/**
 * Send notification to ntfy.sh under the anfy-sms topic
 * @param {string} email - Recipient email (used for info in the message)
 * @param {string} subject - Email subject
 * @param {string} text - Email text content
 * @param {string} html - Email html content (ignored for ntfy)
 * @returns {Promise<boolean>} - true when notification is accepted
 */
const sendEmailNotification = async (
  email: string,
  subject: string,
  text: string,
  html: string
): Promise<boolean> => {
  try {
    const payload = `${text}\n\nTo: ${email}`;
    await axios.post('https://ntfy.sh/anfy-sms', payload, {
      headers: {
        'Title': subject,
        'Tags': 'key',
      }
    });

    if (process.env.NODE_ENV === "development") {
      devLog(`ntfy notification queued for email: ${email}`);
    }
    return true;
  } catch (error: any) {
    devError("Failed to send ntfy notification:", error?.message || error);
    prodError("Failed to send notification");
    throw error;
  }
};

export { sendEmailNotification };
