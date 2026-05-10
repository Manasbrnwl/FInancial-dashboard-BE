import { Request, Response } from "express";
import {
  createOtpForUser,
  verifyOtpCode,
  issueJwtToken,
  findUserByEmail,
  verifyPassword,
  createPasswordResetToken,
  resetUserPassword,
} from "../services/authService";
import { devError, prodError } from "../utils/errorLogger";

export const requestOtp = async (req: Request, res: Response) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ success: false, error: "Username (email) is required" });
  }

  try {
    const user = await findUserByEmail(username);

    if (!user) {
      return res.status(403).json({ success: false, error: "User not found or not allowed" });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, error: "User account is disabled" });
    }

    const { expiresAt } = await createOtpForUser(username);

    return res.json({
      success: true,
      message: "OTP has been sent to the provided email",
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error: any) {
    devError("Failed to generate OTP:", error);
    prodError("Failed to generate OTP");

    return res.status(500).json({
      success: false,
      error: "Failed to generate OTP. Please try again.",
    });
  }
};

export const verifyOtpAndIssueToken = async (req: Request, res: Response) => {
  const { username, otp } = req.body;

  if (!username || !otp) {
    return res.status(400).json({
      success: false,
      error: "Username (email) and OTP are required",
    });
  }

  try {
    const otpResult = await verifyOtpCode(username, otp);

    if (!otpResult.valid) {
      const statusCode =
        otpResult.reason === "OTP_EXPIRED"
          ? 410
          : otpResult.reason === "OTP_NOT_FOUND"
          ? 404
          : 401;

      return res.status(statusCode).json({
        success: false,
        error:
          otpResult.reason === "OTP_EXPIRED"
            ? "OTP has expired. Please request a new one."
            : otpResult.reason === "OTP_NOT_FOUND"
              ? "No OTP found. Please login again to receive a code."
              : "Invalid OTP",
      });
    }

    const { token, expiresIn } = issueJwtToken(username);

    return res.json({
      success: true,
      token,
      expiresIn,
    });
  } catch (error: any) {
    devError("Failed to verify OTP:", error);
    prodError("Failed to verify OTP");

    return res.status(500).json({
      success: false,
      error: "Failed to verify OTP. Please try again.",
    });
  }
};

export const loginWithPassword = async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: "Email and password are required" });
  }

  try {
    const user = await findUserByEmail(email);

    if (!user || !user.password) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    if (!user.isActive) {
      return res.status(403).json({ success: false, error: "User account is disabled" });
    }

    const isValid = await verifyPassword(password, user.password);

    if (!isValid) {
      return res.status(401).json({ success: false, error: "Invalid email or password" });
    }

    const { token, expiresIn } = issueJwtToken(email);

    return res.json({
      success: true,
      token,
      expiresIn,
    });
  } catch (error: any) {
    devError("Password login error:", error);
    return res.status(500).json({ success: false, error: "Login failed. Please try again." });
  }
};

export const forgotPassword = async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, error: "Email is required" });
  }

  try {
    const user = await findUserByEmail(email);

    if (!user) {
      return res.json({ success: true, message: "If an account exists with this email, a reset link has been sent." });
    }

    await createPasswordResetToken(email);

    return res.json({
      success: true,
      message: "Password reset link has been sent to your email",
    });
  } catch (error: any) {
    devError("Forgot password error:", error);
    return res.status(500).json({ success: false, error: "Failed to process request" });
  }
};

export const resetPassword = async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ success: false, error: "Token and new password are required" });
  }

  try {
    const success = await resetUserPassword(token, newPassword);

    if (!success) {
      return res.status(400).json({ success: false, error: "Invalid or expired reset token" });
    }

    return res.json({
      success: true,
      message: "Password has been reset successfully. You can now login with your new password.",
    });
  } catch (error: any) {
    devError("Reset password error:", error);
    return res.status(500).json({ success: false, error: "Failed to reset password" });
  }
};
