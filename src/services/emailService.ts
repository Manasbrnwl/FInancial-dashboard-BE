import { BrevoClient } from "@getbrevo/brevo";
import { devError, devLog } from "../utils/errorLogger";

const apiKey = process.env.BREVO_API_KEY || "";
const client = new BrevoClient({ apiKey });

const SENDER_EMAIL = process.env.BREVO_SENDER_EMAIL || "no-reply@finance-dashboard.com";
const SENDER_NAME = process.env.BREVO_SENDER_NAME || "Finance Dashboard Auth";

export const sendOtpEmail = async (email: string, otp: string, expiryMinutes: number): Promise<boolean> => {
    if (!apiKey) {
        devLog(`[DEV] No BREVO_API_KEY. OTP for ${email} is ${otp}`);
        return true;
    }

    try {
        await client.transactionalEmails.sendTransacEmail({
            subject: "Your Login Verification Code",
            htmlContent: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
                    <h2>Verification Code</h2>
                    <p>Your login OTP is: <strong style="font-size: 24px; color: #3b82f6;">${otp}</strong></p>
                    <p>This code will expire in ${expiryMinutes} minutes.</p>
                    <p style="color: #666; font-size: 12px; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
                </div>
            `,
            sender: { email: SENDER_EMAIL, name: SENDER_NAME },
            to: [{ email }],
        });
        return true;
    } catch (error: any) {
        devError("Brevo Error:", error?.response?.body || error.message);
        return false;
    }
};

export const sendPasswordResetEmail = async (email: string, token: string, expiryHours: number): Promise<boolean> => {
    if (!apiKey) {
        devLog(`[DEV] No BREVO_API_KEY. Reset link for ${email} would use token: ${token}`);
        return true;
    }

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${token}`;

    try {
        await client.transactionalEmails.sendTransacEmail({
            subject: "Password Reset Request",
            htmlContent: `
                <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #eee; border-radius: 5px;">
                    <h2>Reset Your Password</h2>
                    <p>You requested a password reset. Click the button below to set a new password:</p>
                    <div style="margin: 30px 0;">
                        <a href="${resetUrl}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">Reset Password</a>
                    </div>
                    <p>This link will expire in ${expiryHours} hours.</p>
                    <p style="color: #666; font-size: 12px; margin-top: 20px;">If you didn't request this, please ignore this email.</p>
                </div>
            `,
            sender: { email: SENDER_EMAIL, name: SENDER_NAME },
            to: [{ email }],
        });
        return true;
    } catch (error: any) {
        devError("Brevo Error:", error?.response?.body || error.message);
        return false;
    }
};
