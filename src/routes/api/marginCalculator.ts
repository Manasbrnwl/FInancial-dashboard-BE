import { Router } from "express";
import {
  calculateMargin,
  calculateMarginOnly,
  calculateBulkMargins,
  getStoredMargins,
  getLatestMargin,
  cleanupOldMargins,
} from "../../controllers/marginCalculatorController";

const router = Router();

/**
 * @route   POST /api/margin-calculator/calculate
 * @desc    Calculate margin for an order and store in database
 * @access  Private
 * @body    { securityId, symbol?, exchangeSegment, transactionType, quantity, productType, price, triggerPrice? }
 */
router.post("/calculate", calculateMargin);

/**
 * @route   POST /api/margin-calculator/calculate-only
 * @desc    Calculate margin without storing in database
 * @access  Private
 * @body    { securityId, exchangeSegment, transactionType, quantity, productType, price, triggerPrice? }
 */
router.post("/calculate-only", calculateMarginOnly);

/**
 * @route   POST /api/margin-calculator/bulk
 * @desc    Calculate margins for multiple orders
 * @access  Private
 * @body    { orders: Array<MarginCalculatorRequest> }
 */
router.post("/bulk", calculateBulkMargins);

/**
 * @route   GET /api/margin-calculator/stored
 * @desc    Get stored margin calculations
 * @access  Private
 * @query   securityId?, exchangeSegment?, limit?
 */
router.get("/stored", getStoredMargins);

/**
 * @route   GET /api/margin-calculator/latest/:securityId/:exchangeSegment
 * @desc    Get latest margin for a specific security
 * @access  Private
 */
router.get("/latest/:securityId/:exchangeSegment", getLatestMargin);

/**
 * @route   DELETE /api/margin-calculator/cleanup
 * @desc    Cleanup old margin calculations
 * @access  Private
 * @query   daysToKeep? (default: 30)
 */
router.delete("/cleanup", cleanupOldMargins);

export default router;
