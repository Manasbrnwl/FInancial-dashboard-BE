import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import { sendEmailNotification } from "../utils/sendEmail";

type OtpEntry = {
  otp: string;
  expiresAt: number;
};

type JwtExpiresIn = NonNullable<SignOptions["expiresIn"]>;

const otpStore: Map<string, OtpEntry> = new Map();

const getOtpExpirationMinutes = (): number =>
  Number(process.env.OTP_EXPIRATION_MINUTES) || 10;

const getAllowedEmails = (): string[] => {
  const raw = process.env.AUTH_ALLOWED_EMAILS;

  if (!raw) {
    return [];
  }

  const normalized = raw.trim();

  try {
    const parsed = JSON.parse(normalized);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => String(item).trim().toLowerCase())
        .filter(Boolean);
    }
  } catch {
    // fall back to comma parsing
  }

  return raw
    .replace(/[\[\]]/g, "")
    .split(",")
    .map((item) => item.replace(/['"]/g, "").trim().toLowerCase())
    .filter(Boolean);
};

const getJwtExpiresIn = (): JwtExpiresIn => {
  const configuredValue = process.env.JWT_EXPIRES_IN;

  if (!configuredValue) {
    return "1h";
  }

  const numericValue = Number(configuredValue);

  if (!Number.isNaN(numericValue)) {
    return numericValue as JwtExpiresIn;
  }

  return configuredValue as JwtExpiresIn;
};

const getOtpRecipient = (username: string): string | undefined => username;

const generateOtp = (): string => {
  const otp = crypto.randomInt(100000, 999999);
  return otp.toString();
};

export const isValidUser = (username: string): boolean => {
  const trimmed = username.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return false;
  }

  const allowedEmails = getAllowedEmails();
  return allowedEmails.includes(trimmed);
};

export const createOtpForUser = async (
  username: string
): Promise<{ expiresAt: number; recipient: string }> => {
  const otp = generateOtp();
  const otpExpiryMinutes = getOtpExpirationMinutes();
  const expiresAt = Date.now() + otpExpiryMinutes * 60 * 1000;
  const recipient = getOtpRecipient(username);

  if (!recipient) {
    throw new Error("OTP recipient email is not configured");
  }

  otpStore.set(username, { otp, expiresAt });

  const subject = "Your login verification code";
  const text = `Your login OTP is ${otp}. It expires in ${otpExpiryMinutes} minutes.`;
  const html = `<p>Your login OTP is <strong>${otp}</strong>. It expires in ${otpExpiryMinutes} minutes.</p>`;

  await sendEmailNotification(recipient, subject, text, html);

  return { expiresAt, recipient };
};

export const verifyOtpCode = (
  username: string,
  otp: string
): { valid: boolean; reason?: "OTP_EXPIRED" | "OTP_INVALID" | "OTP_NOT_FOUND" } => {
  const entry = otpStore.get(username);

  if (!entry) {
    return { valid: false, reason: "OTP_NOT_FOUND" };
  }

  if (Date.now() > entry.expiresAt) {
    otpStore.delete(username);
    return { valid: false, reason: "OTP_EXPIRED" };
  }

  if (entry.otp !== otp) {
    return { valid: false, reason: "OTP_INVALID" };
  }

  otpStore.delete(username);
  return { valid: true };
};

export const issueJwtToken = (
  username: string
): { token: string; expiresIn: string } => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = getJwtExpiresIn();

  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  const token = jwt.sign({ username }, secret, {
    expiresIn,
  });

  return { token, expiresIn: String(expiresIn) };
};
