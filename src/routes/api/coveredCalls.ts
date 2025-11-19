import { Router } from "express";
import {
  getCoveredCallsData,
  getCoveredCallsByUnderlying,
  getCoveredCallsSymbolsExpiry,
  getFilteredCoveredCallsDetails,
  getLatestOptionsTicksByInstrument,
  getCoveredCallsTrendDaily,
  getCoveredCallsTrendHourly,
} from "../../controllers/coveredCallsController";

const router = Router();

// GET /api/covered-calls - Get all covered calls data
router.get("/", getCoveredCallsData);

// GET /api/covered-calls/by-underlying?underlying=SYMBOL - Get covered calls filtered by underlying symbol
router.get("/by-underlying", getCoveredCallsByUnderlying);

// GET /api/covered-calls-details/:instrumentId/symbols-expiry - Get symbols and expiry dates for filter dropdowns
router.get("/:instrumentId/symbols-expiry", getCoveredCallsSymbolsExpiry);

// GET /api/covered-calls-details/:instrumentId/filtered - Get filtered covered calls details with pagination
router.get("/:instrumentId/filtered", getFilteredCoveredCallsDetails);

// GET /api/covered-calls/:instrumentId/latest - latest options ticks per symbol (historical fallback)
router.get("/:instrumentId/latest", getLatestOptionsTicksByInstrument);

// GET /api/covered-calls/:instrumentId/trend/daily - daily trend data for options
router.get("/:instrumentId/trend/daily", getCoveredCallsTrendDaily);

// GET /api/covered-calls/:instrumentId/trend/hourly - hourly trend data for options
router.get("/:instrumentId/trend/hourly", getCoveredCallsTrendHourly);

export default router;
