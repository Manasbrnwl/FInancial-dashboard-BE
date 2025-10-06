import { Router } from "express";
import {
  getBseEquityData,
  getBseEquitySymbols,
  getBseEquityLatest,
} from "../../controllers/bseEquityController";

const router = Router();

// GET /api/bse-equity - Get BSE equity data with filters
router.get("/", getBseEquityData);

// GET /api/bse-equity/symbols - Get all unique symbols
router.get("/symbols", getBseEquitySymbols);

// GET /api/bse-equity/:symbol/latest - Get latest data for a symbol
router.get("/:symbol/latest", getBseEquityLatest);

export default router;
