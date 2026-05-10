import { Router } from "express";
import {
  requestOtp,
  verifyOtpAndIssueToken,
  loginWithPassword,
  forgotPassword,
  resetPassword,
} from "../controllers/authController";

const router = Router();

// OTP Flow
router.post("/request-otp", requestOtp);
router.post("/verify-otp", verifyOtpAndIssueToken);

// Password Flow
router.post("/login-password", loginWithPassword);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

// Legacy/Compatibility
router.post("/login", requestOtp);

export default router;
