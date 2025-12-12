import cron from "node-cron";
import { upstoxAuthService } from "../services/upstoxAuthService";
import { sendEmailNotification } from "../utils/sendEmail";

const TARGET_EMAIL = process.env.GAP_ALERT_EMAILS;

/**
 * Execute the login reminder email logic.
 */
async function sendLoginReminder() {
    try {
        const loginUrl = upstoxAuthService.getLoginUrl();
        const currentDate = new Date().toDateString();

        const subject = `ACTION REQUIRED: Upstox Login for ${currentDate}`;
        const html = `
      <h3>Good Morning!</h3>
      <p>Please log in to Upstox to enable the 5-minute option ticks job for today.</p>
      <p><strong>Step 1:</strong> Click the link below to authorize.</p>
      <p><a href="${loginUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Login to Upstox</a></p>
      <p style="margin-top: 20px;">Or copy paste this URL:</p>
      <pre>${loginUrl}</pre>
      <p><em>This link will redirect to your server's callback handler and auto-generate the token.</em></p>
    `;
        const text = `Please log in to Upstox: ${loginUrl}`;

        if (TARGET_EMAIL) {
            await sendEmailNotification(TARGET_EMAIL, subject, text, html);
            console.log(`? Login reminder email sent to ${TARGET_EMAIL}`);
        } else {
            console.error("? No email recipient configured for login reminder.");
        }

    } catch (error: any) {
        console.error("? Failed to send login reminder:", error.message);
    }
}

/**
 * Initialize the daily login reminder job.
 */
export function initializeLoginReminderJob(): void {
    // Run at 8:00 AM on Weekdays (Mon-Fri)
    const schedule = "0 8 * * 1-5";
    if (process.env.NODE_ENV === "production") {
        sendLoginReminder();
    }
    cron.schedule(schedule, sendLoginReminder, {
        timezone: "Asia/Kolkata",
    });
    console.log(`? Login Reminder Job Scheduled (${schedule})`);
}
