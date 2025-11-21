import axios from "axios";
import { loadEnv } from "../config/env";

loadEnv();

const SMS_API_URL = process.env.SMS_API_URL;
const SMS_API_KEY = process.env.SMS_API_KEY;
const SMS_SENDER_ID = process.env.SMS_SENDER_ID;

/**
 * Send SMS notification using a generic HTTP gateway.
 * Expects a bearer/API key auth and JSON body. Adjust to match your provider.
 */
export async function sendSmsNotification(
  phoneNumber: string,
  message: string
): Promise<boolean> {
  if (!SMS_API_URL || !SMS_API_KEY) {
    console.warn("? SMS API URL or key not configured; skipping SMS send");
    return false;
  }

  try {
    await axios.post(
      SMS_API_URL,
      {
        to: phoneNumber,
        message,
        senderId: SMS_SENDER_ID,
      },
      {
        headers: {
          Authorization: `Bearer ${SMS_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
      }
    );
    return true;
  } catch (error: any) {
    console.error("? Failed to send SMS:", error?.message || error);
    return false;
  }
}
