import { Router } from "express";
import {
  getEquitiesWithDerivatives,
  getSymbolsForEquity,
} from "../../controllers/liveDataController";

const router = Router();

router.get("/equities", getEquitiesWithDerivatives);
router.get("/equities/:instrumentId/symbols", getSymbolsForEquity);

export default router;
