import { Router } from "express";
import nseEquityRouter from "./nseEquity";
import bseEquityRouter from "./bseEquity";
import nseFuturesRouter from "./nseFutures";
import nseOptionsRouter from "./nseOptions";
import periodicDataRouter from "./periodicData";

const router = Router();

// Mount individual route modules
router.use("/nse-equity", nseEquityRouter);
router.use("/bse-equity", bseEquityRouter);
router.use("/nse-futures", nseFuturesRouter);
router.use("/nse-options", nseOptionsRouter);
router.use("/periodic-data", periodicDataRouter);

// Health check endpoint
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "API is running",
    timestamp: new Date().toISOString(),
  });
});

export default router;
