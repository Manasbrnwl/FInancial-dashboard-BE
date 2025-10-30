import { Router } from "express";
import {
  getArbitrageDetails,
  getLiveDataForSymbols,
  getFilteredArbitrageData,
} from "../../controllers/arbitrageDetailsController";

const router = Router();

// Get arbitrage details for a specific instrument
router.get("/:instrumentId", getArbitrageDetails);

// Get live data for symbols
router.get("/:instrumentId/live", getLiveDataForSymbols);

// Get filtered arbitrage data with pagination
router.get("/:instrumentId/filtered", getFilteredArbitrageData);

export default router;
