import { Request, Response } from "express";
import {
  marginCalculatorService,
  MarginCalculatorRequest,
  ExchangeSegment,
  TransactionType,
  ProductType,
} from "../services/marginCalculatorService";

/**
 * Calculate margin for a single order
 */
export const calculateMargin = async (req: Request, res: Response) => {
  try {
    const {
      securityId,
      symbol,
      exchangeSegment,
      transactionType,
      quantity,
      productType,
      price,
      triggerPrice,
    } = req.body;

    // Validation
    if (!securityId || !exchangeSegment || !transactionType || !quantity || !productType || !price) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields: securityId, exchangeSegment, transactionType, quantity, productType, price",
      });
    }

    // Validate enum values
    if (!Object.values(ExchangeSegment).includes(exchangeSegment)) {
      return res.status(400).json({
        success: false,
        error: `Invalid exchangeSegment. Must be one of: ${Object.values(ExchangeSegment).join(", ")}`,
      });
    }

    if (!Object.values(TransactionType).includes(transactionType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid transactionType. Must be one of: ${Object.values(TransactionType).join(", ")}`,
      });
    }

    if (!Object.values(ProductType).includes(productType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid productType. Must be one of: ${Object.values(ProductType).join(", ")}`,
      });
    }

    const request: MarginCalculatorRequest = {
      securityId,
      symbol,
      exchangeSegment,
      transactionType,
      quantity: parseInt(quantity),
      productType,
      price: parseFloat(price),
      ...(triggerPrice && { triggerPrice: parseFloat(triggerPrice) }),
    };

    const marginData = await marginCalculatorService.calculateAndStore(request);

    res.json({
      success: true,
      data: marginData,
    });
  } catch (error: any) {
    console.error("Error calculating margin:", error);
    res.status(500).json({
      success: false,
      error: "Failed to calculate margin",
      message: error.message,
    });
  }
};

/**
 * Calculate margin without storing in database
 */
export const calculateMarginOnly = async (req: Request, res: Response) => {
  try {
    const {
      securityId,
      exchangeSegment,
      transactionType,
      quantity,
      productType,
      price,
      triggerPrice,
    } = req.body;

    // Validation
    if (!securityId || !exchangeSegment || !transactionType || !quantity || !productType || !price) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields",
      });
    }

    const request: MarginCalculatorRequest = {
      securityId,
      exchangeSegment,
      transactionType,
      quantity: parseInt(quantity),
      productType,
      price: parseFloat(price),
      ...(triggerPrice && { triggerPrice: parseFloat(triggerPrice) }),
    };

    const marginData = await marginCalculatorService.calculateMargin(request);

    res.json({
      success: true,
      data: marginData,
    });
  } catch (error: any) {
    console.error("Error calculating margin:", error);
    res.status(500).json({
      success: false,
      error: "Failed to calculate margin",
      message: error.message,
    });
  }
};

/**
 * Calculate margins for multiple orders
 */
export const calculateBulkMargins = async (req: Request, res: Response) => {
  try {
    const { orders } = req.body;

    if (!orders || !Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({
        success: false,
        error: "orders array is required and must not be empty",
      });
    }

    // Validate each order
    for (let i = 0; i < orders.length; i++) {
      const order = orders[i];
      if (!order.securityId || !order.exchangeSegment || !order.transactionType ||
          !order.quantity || !order.productType || !order.price) {
        return res.status(400).json({
          success: false,
          error: `Order at index ${i} is missing required fields`,
        });
      }
    }

    const result = await marginCalculatorService.calculateBulkMargins(orders);

    res.json({
      success: true,
      data: result,
    });
  } catch (error: any) {
    console.error("Error calculating bulk margins:", error);
    res.status(500).json({
      success: false,
      error: "Failed to calculate bulk margins",
      message: error.message,
    });
  }
};

/**
 * Get stored margin calculations
 */
export const getStoredMargins = async (req: Request, res: Response) => {
  try {
    const { securityId, exchangeSegment, limit } = req.query;

    const filters = {
      ...(securityId && { securityId: securityId as string }),
      ...(exchangeSegment && { exchangeSegment: exchangeSegment as string }),
      ...(limit && { limit: parseInt(limit as string) }),
    };

    const margins = await marginCalculatorService.getStoredMargins(filters);

    res.json({
      success: true,
      data: margins,
      count: margins.length,
    });
  } catch (error: any) {
    console.error("Error fetching stored margins:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch stored margins",
      message: error.message,
    });
  }
};

/**
 * Get latest margin for a specific security
 */
export const getLatestMargin = async (req: Request, res: Response) => {
  try {
    const { securityId, exchangeSegment } = req.params;

    if (!securityId || !exchangeSegment) {
      return res.status(400).json({
        success: false,
        error: "securityId and exchangeSegment are required",
      });
    }

    const margin = await marginCalculatorService.getLatestMargin(
      securityId,
      exchangeSegment
    );

    if (!margin) {
      return res.status(404).json({
        success: false,
        error: "No margin calculation found for this security",
      });
    }

    res.json({
      success: true,
      data: margin,
    });
  } catch (error: any) {
    console.error("Error fetching latest margin:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch latest margin",
      message: error.message,
    });
  }
};

/**
 * Cleanup old margin calculations
 */
export const cleanupOldMargins = async (req: Request, res: Response) => {
  try {
    const { daysToKeep } = req.query;
    const days = daysToKeep ? parseInt(daysToKeep as string) : 30;

    const deletedCount = await marginCalculatorService.cleanupOldMargins(days);

    res.json({
      success: true,
      message: `Cleaned up ${deletedCount} old margin calculations`,
      deletedCount,
    });
  } catch (error: any) {
    console.error("Error cleaning up margins:", error);
    res.status(500).json({
      success: false,
      error: "Failed to cleanup margins",
      message: error.message,
    });
  }
};
