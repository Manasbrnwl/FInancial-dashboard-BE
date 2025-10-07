import { Router } from "express";
import { getArbitrageData } from "../../controllers/arbitrageController";

const router = Router();

// GET /api/arbitrage - Get arbitrage data
router.get("/", getArbitrageData);


export default router;