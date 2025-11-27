import nodemailer from "nodemailer";
import dotenv from "dotenv";

dotenv.config();

// Define the transporter object with the Gmail SMTP settings
const transporter = nodemailer.createTransport({
  service: "gmail",
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

/**
 * Send email notification
 * @param {string} email - Recipient email
 * @param {string} subject - Email subject
 * @param {string} text - Email text content
 * @param {string} html - Email html content
 * @returns {Promise<boolean>} - true when mail is accepted
 */
const sendEmailNotification = async (
  email: string,
  subject: string,
  text: string,
  html: string
): Promise<boolean> => {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject,
      text,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    if (process.env.NODE_ENV === "development") {
      console.log(`OTP email queued: ${info.messageId}`);
    }
    return true;
  } catch (error: any) {
    console.error("Failed to send OTP email:", error?.message || error);
    throw error;
  }
};

export { sendEmailNotification };
