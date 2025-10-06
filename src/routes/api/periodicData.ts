import { Router } from "express";
import {
  getOhlcDataNSE,
  getTicksDataNSEEQ,
  getTicksDataNSEFUT,
  getTicksDataNSEOPT,
  getOhlcDataBSE,
} from "../../controllers/periodicDataController";

const router = Router();

// GET /api/periodic-data/ohlc/nse - Get OHLC NSE data
router.get("/ohlc/nse", getOhlcDataNSE);

// GET /api/periodic-data/ohlc/bse - Get OHLC BSE data
router.get("/ohlc/bse", getOhlcDataBSE);

// GET /api/periodic-data/ticks/nse-eq - Get Ticks NSE EQ data
router.get("/ticks/nse-eq", getTicksDataNSEEQ);

// GET /api/periodic-data/ticks/nse-fut - Get Ticks NSE FUT data
router.get("/ticks/nse-fut", getTicksDataNSEFUT);

// GET /api/periodic-data/ticks/nse-opt - Get Ticks NSE OPT data
router.get("/ticks/nse-opt", getTicksDataNSEOPT);

export default router;
