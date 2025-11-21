import { Router } from "express";
import nseEquityRouter from "./nseEquity";
import bseEquityRouter from "./bseEquity";
import nseFuturesRouter from "./nseFutures";
import nseOptionsRouter from "./nseOptions";
import periodicDataRouter from "./periodicData";
import arbitrageRouter from "./arbitrage";
import coveredCallsRouter from "./coveredCalls";
import arbitrageDetailsRouter from "./arbitrageDetails";
import cronStatusRouter from "./cronStatus";
import gapAlertsRouter from "./gapAlerts";

const router = Router();

// Mount individual route modules
router.use("/nse-equity", nseEquityRouter);
router.use("/bse-equity", bseEquityRouter);
router.use("/nse-futures", nseFuturesRouter);
router.use("/nse-options", nseOptionsRouter);
router.use("/periodic-data", periodicDataRouter);
router.use("/arbitrage", arbitrageRouter);
router.use("/covered-calls", coveredCallsRouter);
router.use("/arbitrage-details", arbitrageDetailsRouter);
router.use("/cron-status", cronStatusRouter);
router.use("/gap-alerts", gapAlertsRouter);

// Health check endpoint
router.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "API is running",
    timestamp: new Date().toISOString(),
  });
});

export default router;
