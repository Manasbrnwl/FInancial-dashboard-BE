import { Router } from "express";
import {
  getRecentAlerts,
  getAlertHistory,
  getGapHistory,
  reloadGapBaselines,
} from "../../controllers/gapAlertController";

const router = Router();

router.get("/", getRecentAlerts);
router.get("/history", getAlertHistory);
router.get("/gaps/:instrumentId", getGapHistory);
router.post("/reload-baselines", reloadGapBaselines);

export default router;
