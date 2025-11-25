import { Router } from "express";
import {
  loginWithPassword,
  verifyOtpAndIssueToken,
} from "../controllers/authController";

const router = Router();

router.post("/login", loginWithPassword);
router.post("/verify-otp", verifyOtpAndIssueToken);

export default router;
