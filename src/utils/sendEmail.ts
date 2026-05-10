import { BrevoClient } from "@getbrevo/brevo";
import { devError, devLog, prodError } from "./errorLogger";

const apiKey = process.env.BREVO_API_KEY || "";
const client = new BrevoClient({ apiKey });

const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "no-reply@finance-dashboard.com";
const SENDER_NAME = process.env.BREVO_SENDER_NAME || "Finance Dashboard Alerts";

/**
 * Send notification via Brevo Email Service
 * @param {string} email - Recipient email
 * @param {string} subject - Email subject
 * @param {string} text - Email text content
 * @param {string} html - Email html content
 * @returns {Promise<boolean>} - true when email is sent
 */
const sendEmailNotification = async (
  email: string,
  subject: string,
  text: string,
  html: string
): Promise<boolean> => {
  if (!apiKey) {
    devLog(`[DEV] No BREVO_API_KEY. Email to ${email} would be: ${subject}`);
    return true;
  }

  try {
    await client.transactionalEmails.sendTransacEmail({
      subject: subject,
      htmlContent: html || `<p>${text}</p>`,
      textContent: text,
      sender: { email: SENDER_EMAIL, name: SENDER_NAME },
      to: [{ email }],
    });
    
    if (process.env.NODE_ENV === "development") {
      devLog(`Email sent to ${email}: ${subject}`);
    }
    return true;
  } catch (error: any) {
    devError("Failed to send Brevo email:", error?.response?.body || error.message);
    prodError("Failed to send email notification");
    throw error;
  }
};

export { sendEmailNotification };
