import { Router } from "express";
import {
  getArbitrageDetails,
  getLiveDataForSymbols,
  getFilteredArbitrageData,
} from "../../controllers/arbitrageDetailsController";
import { getSymbolArbitrageHistory } from "../../controllers/arbitrageHistoryController";
import { cacheResponse } from "../../middleware/responseCache";

const router = Router();

// Get arbitrage details for a specific instrument
router.get("/:instrumentId", cacheResponse(30), getArbitrageDetails);

// Get live data for symbols (intentionally uncached — meant to be as fresh as possible)
router.get("/:instrumentId/live", getLiveDataForSymbols);

// Get filtered arbitrage data with pagination
router.get("/:instrumentId/filtered", cacheResponse(30), getFilteredArbitrageData);

// Get aggregated arbitrage history
router.get("/:instrumentId/history", getSymbolArbitrageHistory);

export default router;
