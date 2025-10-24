import { Router } from "express";
import {
  getCoveredCallsData,
  getCoveredCallsByUnderlying,
} from "../../controllers/coveredCallsController";

const router = Router();

// GET /api/covered-calls - Get all covered calls data
router.get("/", getCoveredCallsData);

// GET /api/covered-calls/by-underlying?underlying=SYMBOL - Get covered calls filtered by underlying symbol
router.get("/by-underlying", getCoveredCallsByUnderlying);

export default router;
