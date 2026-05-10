import crypto from "crypto";
import jwt from "jsonwebtoken";
import type { SignOptions } from "jsonwebtoken";
import bcrypt from "bcryptjs";
import prisma from "../config/prisma";
import { sendOtpEmail, sendPasswordResetEmail } from "./emailService";

type JwtExpiresIn = NonNullable<SignOptions["expiresIn"]>;

const getOtpExpirationMinutes = (): number =>
  Number(process.env.OTP_EXPIRATION_MINUTES) || 10;

const getJwtExpiresIn = (): JwtExpiresIn => {
  const configuredValue = process.env.JWT_EXPIRES_IN;
  if (!configuredValue) return "1h";
  const numericValue = Number(configuredValue);
  return !Number.isNaN(numericValue) ? (numericValue as JwtExpiresIn) : (configuredValue as JwtExpiresIn);
};

const generateOtp = (): string => {
  return crypto.randomInt(100000, 999999).toString();
};

const generateToken = (): string => {
  return crypto.randomBytes(32).toString("hex");
};

export const findUserByEmail = async (email: string) => {
  return await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() },
  });
};

export const createOtpForUser = async (
  email: string
): Promise<{ expiresAt: Date }> => {
  const otp = generateOtp();
  const otpExpiryMinutes = getOtpExpirationMinutes();
  const expiresAt = new Date(Date.now() + otpExpiryMinutes * 60 * 1000);

  await prisma.user.update({
    where: { email: email.trim().toLowerCase() },
    data: {
      otp,
      otpExpiresAt: expiresAt,
    },
  });

  await sendOtpEmail(email, otp, otpExpiryMinutes);
  
  if (process.env.NODE_ENV === "development") {
    console.log(`[Dev] OTP generated for ${email}: ${otp}`);
  }

  return { expiresAt };
};

export const verifyOtpCode = async (
  email: string,
  otp: string
): Promise<{ valid: boolean; reason?: "OTP_EXPIRED" | "OTP_INVALID" | "OTP_NOT_FOUND" }> => {
  const user = await findUserByEmail(email);

  if (!user || !user.otp) {
    return { valid: false, reason: "OTP_NOT_FOUND" };
  }

  if (user.otp !== otp) {
    return { valid: false, reason: "OTP_INVALID" };
  }

  if (user.otpExpiresAt && user.otpExpiresAt < new Date()) {
    return { valid: false, reason: "OTP_EXPIRED" };
  }

  // Clear OTP after successful verification
  await prisma.user.update({
    where: { id: user.id },
    data: { otp: null, otpExpiresAt: null },
  });

  return { valid: true };
};

export const hashPassword = async (password: string): Promise<string> => {
  return await bcrypt.hash(password, 10);
};

export const verifyPassword = async (password: string, hashed: string): Promise<boolean> => {
  return await bcrypt.compare(password, hashed);
};

export const createPasswordResetToken = async (email: string) => {
  const token = generateToken();
  const expiresAt = new Date(Date.now() + 1 * 60 * 60 * 1000); // 1 hour

  await prisma.user.update({
    where: { email: email.trim().toLowerCase() },
    data: {
      resetToken: token,
      resetTokenExpires: expiresAt,
    },
  });

  await sendPasswordResetEmail(email, token, 1);
  return token;
};

export const resetUserPassword = async (token: string, newPassword: string) => {
  const user = await prisma.user.findFirst({
    where: {
      resetToken: token,
      resetTokenExpires: { gte: new Date() },
    },
  });

  if (!user) return false;

  const hashedPassword = await hashPassword(newPassword);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedPassword,
      resetToken: null,
      resetTokenExpires: null,
    },
  });

  return true;
};

export const issueJwtToken = (
  email: string
): { token: string; expiresIn: string } => {
  const secret = process.env.JWT_SECRET;
  const expiresIn = getJwtExpiresIn();

  if (!secret) {
    throw new Error("JWT_SECRET is not configured");
  }

  const token = jwt.sign({ email }, secret, {
    expiresIn,
  });

  return { token, expiresIn: String(expiresIn) };
};
