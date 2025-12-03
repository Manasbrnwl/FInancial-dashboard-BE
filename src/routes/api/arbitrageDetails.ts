import { Router } from "express";
import {
  getArbitrageDetails,
  getLiveDataForSymbols,
  getFilteredArbitrageData,
} from "../../controllers/arbitrageDetailsController";
import { getSymbolArbitrageHistory } from "../../controllers/arbitrageHistoryController";

const router = Router();

// Get arbitrage details for a specific instrument
router.get("/:instrumentId", getArbitrageDetails);

// Get live data for symbols
router.get("/:instrumentId/live", getLiveDataForSymbols);

// Get filtered arbitrage data with pagination
router.get("/:instrumentId/filtered", getFilteredArbitrageData);

// Get aggregated arbitrage history
router.get("/:instrumentId/history", getSymbolArbitrageHistory);

export default router;
