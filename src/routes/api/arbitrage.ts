import { Router } from "express";
import { getArbitrageData, getNSEOptionsData, getNSEFuturesData, getNSEFuturesTicksData, getNSEOptionsTicksData } from "../../controllers/arbitrageController";

const router = Router();

// GET /api/arbitrage - Get arbitrage data
router.get("/", getArbitrageData);

// GET /api/arbitrage/nse-options?instrumentId=13461 - Get NSE options historical data for specific instrument
router.get("/nse-options", getNSEOptionsData);

// GET /api/arbitrage/nse-futures?instrumentId=13461 - Get NSE futures historical data for specific instrument
router.get("/nse-futures", getNSEFuturesData);

// GET /api/arbitrage/nse-futures-ticks?instrumentId=13461 - Get NSE futures live ticks data for specific instrument
router.get("/nse-futures-ticks", getNSEFuturesTicksData);

// GET /api/arbitrage/nse-options-ticks?instrumentId=13461 - Get NSE options live ticks data for specific instrument
router.get("/nse-options-ticks", getNSEOptionsTicksData);

export default router;
