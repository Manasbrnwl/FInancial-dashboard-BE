import { Router } from "express";
import {
  getNseFuturesData,
  getNseFuturesUnderlyings,
  getNseFuturesExpiries,
} from "../../controllers/nseFuturesController";

const router = Router();

// GET /api/nse-futures - Get NSE futures data with filters
router.get("/", getNseFuturesData);

// GET /api/nse-futures/underlyings - Get all unique underlyings
router.get("/underlyings", getNseFuturesUnderlyings);

// GET /api/nse-futures/expiries - Get all expiry dates (optionally filtered by underlying)
router.get("/expiries", getNseFuturesExpiries);

export default router;
