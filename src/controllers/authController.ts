import { Request, Response } from "express";
import { logger } from "../utils/logger";
import {
  createOtpForUser,
  issueJwtToken,
  isValidUser,
  verifyOtpCode,
} from "../services/authService";
import { devError, prodError } from "../utils/errorLogger";

export const loginWithPassword = async (req: Request, res: Response) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({
      success: false,
      error: "Username (email) is required",
    });
  }

  try {
    if (!isValidUser(username)) {
      return res.status(403).json({
        success: false,
        error: "Email is not authorized for login",
      });
    }

    const { expiresAt } = await createOtpForUser(username);

    return res.json({
      success: true,
      message: "OTP has been sent to the provided email",
      expiresAt: new Date(expiresAt).toISOString(),
    });
  } catch (error: any) {
    devError("Failed to generate OTP:", error);
    prodError("Failed to generate OTP");
    return res.status(500).json({
      success: false,
      error: "Failed to generate OTP. Please try again.",
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
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

  if (!isValidUser(username)) {
    return res.status(403).json({
      success: false,
      error: "Email is not authorized for login",
    });
  }

  try {
    const otpResult = verifyOtpCode(username, otp);

    if (!otpResult.valid) {
      const status =
        otpResult.reason === "OTP_EXPIRED"
          ? 410
          : otpResult.reason === "OTP_NOT_FOUND"
            ? 400
            : 401;

      return res.status(status).json({
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
      ...(process.env.NODE_ENV !== "production" && { message: error.message }),
    });
  }
};
