import { Router } from "express";
import {
  getNseOptionsData,
  getNseOptionsUnderlyings,
  getNseOptionsStrikes,
  getNseOptionsExpiries,
} from "../../controllers/nseOptionsController";

const router = Router();

// GET /api/nse-options - Get NSE options data with filters
router.get("/", getNseOptionsData);

// GET /api/nse-options/underlyings - Get all unique underlyings
router.get("/underlyings", getNseOptionsUnderlyings);

// GET /api/nse-options/strikes - Get all strikes (optionally filtered by underlying and expiry)
router.get("/strikes", getNseOptionsStrikes);

// GET /api/nse-options/expiries - Get all expiry dates (optionally filtered by underlying)
router.get("/expiries", getNseOptionsExpiries);

export default router;
