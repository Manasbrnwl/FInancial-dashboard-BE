import { Router } from "express";
import {
  getNseEquityData,
  getNseEquitySymbols,
  getNseEquityLatest,
} from "../../controllers/nseEquityController";

const router = Router();

// GET /api/nse-equity - Get NSE equity data with filters
router.get("/", getNseEquityData);

// GET /api/nse-equity/symbols - Get all unique symbols
router.get("/symbols", getNseEquitySymbols);

// GET /api/nse-equity/:symbol/latest - Get latest data for a symbol
router.get("/:symbol/latest", getNseEquityLatest);

export default router;
