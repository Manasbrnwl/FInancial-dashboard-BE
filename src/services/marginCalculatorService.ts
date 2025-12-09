import axios from "axios";
import { config } from "dotenv";
import { getDhanAccessToken } from "../config/store";
import prisma from "../config/prisma";

config();

/**
 * Exchange segment types for DhanHQ
 */
export enum ExchangeSegment {
  NSE_EQ = "NSE_EQ",
  NSE_FNO = "NSE_FNO",
  BSE_EQ = "BSE_EQ",
  BSE_FNO = "BSE_FNO",
}

/**
 * Transaction types
 */
export enum TransactionType {
  BUY = "BUY",
  SELL = "SELL",
}

/**
 * Product types for trading
 */
export enum ProductType {
  CNC = "CNC", // Cash and Carry (Delivery)
  INTRADAY = "INTRADAY", // Intraday
  MARGIN = "MARGIN", // Margin (MTF - Margin Trading Facility)
  MTF = "MTF", // Margin Trading Facility
  CO = "CO", // Cover Order
  BO = "BO", // Bracket Order
}

/**
 * Margin calculation request parameters
 */
export interface MarginCalculatorRequest {
  securityId: string;
  symbol?: string;
  exchangeSegment: ExchangeSegment;
  transactionType: TransactionType;
  quantity: number;
  productType: ProductType;
  price: number;
  triggerPrice?: number;
}

/**
 * Margin calculation response from DhanHQ API
 */
export interface MarginCalculatorResponse {
  totalMargin: number;
  spanMargin: number;
  exposureMargin: number;
  availableBalance: number;
  variableMargin: number;
  insufficientBalance: number;
  brokerage: number;
  leverage: string;
}

/**
 * Margin Calculator Service
 * Fetches margin requirements from DhanHQ API and stores them in database
 */
class MarginCalculatorService {
  private readonly API_URL = "https://api.dhan.co/v2/margincalculator";
  private readonly clientId: string;

  constructor() {
    this.clientId = process.env.DHAN_CLIENT_ID || "";
  }

  /**
   * Calculate margin for a given order
   */
  async calculateMargin(
    request: MarginCalculatorRequest
  ): Promise<MarginCalculatorResponse> {
    try {
      const token = getDhanAccessToken();

      if (!token) {
        throw new Error(
          "DhanHQ access token not available. Ensure dhanTokenManager is initialized."
        );
      }

      if (!this.clientId) {
        throw new Error("DHAN_CLIENT_ID is not set in environment variables");
      }

      if (process.env.NODE_ENV === "development") {
        console.log(
          `📊 Calculating margin for ${request.symbol || request.securityId} (${request.exchangeSegment
          })`
        );
      }
console.log(request)
      const response = await axios.post(
        this.API_URL,
        {
          dhanClientId: this.clientId,
          exchangeSegment: request.exchangeSegment,
          transactionType: request.transactionType,
          quantity: request.quantity,
          productType: request.productType,
          securityId: request.securityId,
          price: request.price,
          ...(request.triggerPrice && { triggerPrice: request.triggerPrice }),
        },
        {
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "access-token": token
          },
        }
      );

      return response.data;
    } catch (error: any) {
      console.error("❌ Error calculating margin:", error.message);
      if (error.response) {
        console.error(
          `API Error (${error.response.status}):`,
          error.response.data
        );
      }
      throw error;
    }
  }

  /**
   * Calculate margin and store in database
   */
  async calculateAndStore(
    request: MarginCalculatorRequest
  ): Promise<MarginCalculatorResponse> {
    try {
      // Calculate margin from API
      const marginData = await this.calculateMargin(request);

      // Store in database
      await prisma.margin_calculations.upsert({
        where: {
          security_id_exchange_segment_transaction_type_quantity_product_type_price:
          {
            security_id: request.securityId,
            exchange_segment: request.exchangeSegment,
            transaction_type: request.transactionType,
            quantity: request.quantity,
            product_type: request.productType,
            price: request.price,
          },
        },
        update: {
          symbol: request.symbol || request.securityId,
          trigger_price: request.triggerPrice,
          total_margin: marginData.totalMargin,
          span_margin: marginData.spanMargin,
          exposure_margin: marginData.exposureMargin,
          available_balance: marginData.availableBalance,
          variable_margin: marginData.variableMargin,
          insufficient_balance: marginData.insufficientBalance,
          brokerage: marginData.brokerage,
          leverage: marginData.leverage,
        },
        create: {
          security_id: request.securityId,
          symbol: request.symbol || request.securityId,
          exchange_segment: request.exchangeSegment,
          transaction_type: request.transactionType,
          quantity: request.quantity,
          product_type: request.productType,
          price: request.price,
          trigger_price: request.triggerPrice,
          total_margin: marginData.totalMargin,
          span_margin: marginData.spanMargin,
          exposure_margin: marginData.exposureMargin,
          available_balance: marginData.availableBalance,
          variable_margin: marginData.variableMargin,
          insufficient_balance: marginData.insufficientBalance,
          brokerage: marginData.brokerage,
          leverage: marginData.leverage,
          updated_at: new Date(),
        },
      });

      if (process.env.NODE_ENV === "development") {
        console.log(
          `✅ Margin calculated and stored for ${request.symbol || request.securityId
          }`
        );
        console.log(`   Total Margin: ₹${marginData.totalMargin.toFixed(2)}`);
        console.log(`   Leverage: ${marginData.leverage}x`);
      }

      return marginData;
    } catch (error: any) {
      console.error(
        `❌ Failed to calculate and store margin for ${request.symbol || request.securityId
        }:`,
        error.message
      );
      throw error;
    }
  }

  /**
   * Calculate margin for multiple orders
   */
  async calculateBulkMargins(requests: MarginCalculatorRequest[]): Promise<{
    successful: number;
    failed: number;
    results: Array<{
      request: MarginCalculatorRequest;
      success: boolean;
      data?: MarginCalculatorResponse;
      error?: string;
    }>;
  }> {
    if (process.env.NODE_ENV === "development") {
      console.log(`📊 Calculating margins for ${requests.length} orders...`);
    }

    let successful = 0;
    let failed = 0;
    const results: Array<{
      request: MarginCalculatorRequest;
      success: boolean;
      data?: MarginCalculatorResponse;
      error?: string;
    }> = [];

    for (const request of requests) {
      try {
        const data = await this.calculateAndStore(request);
        results.push({ request, success: true, data });
        successful++;

        // Small delay to avoid rate limiting
        await this.delay(500);
      } catch (error: any) {
        results.push({
          request,
          success: false,
          error: error.message,
        });
        failed++;
      }
    }

    if (process.env.NODE_ENV === "development") {
      console.log(
        `✅ Bulk margin calculation completed: ${successful} successful, ${failed} failed`
      );
    }

    return { successful, failed, results };
  }

  /**
   * Get stored margin calculations from database
   */
  async getStoredMargins(filters?: {
    securityId?: string;
    exchangeSegment?: string;
    limit?: number;
  }) {
    const where: any = {};

    if (filters?.securityId) {
      where.security_id = filters.securityId;
    }

    if (filters?.exchangeSegment) {
      where.exchange_segment = filters.exchangeSegment;
    }

    const margins = await prisma.margin_calculations.findMany({
      where,
      orderBy: { created_at: "desc" },
      take: filters?.limit || 100,
    });

    return margins;
  }

  /**
   * Get latest margin calculation for a specific security
   */
  async getLatestMargin(securityId: string, exchangeSegment: string) {
    return await prisma.margin_calculations.findFirst({
      where: {
        security_id: securityId,
        exchange_segment: exchangeSegment,
      },
      orderBy: { created_at: "desc" },
    });
  }

  /**
   * Delete old margin calculations (cleanup)
   */
  async cleanupOldMargins(daysToKeep: number = 30) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

    const deleted = await prisma.margin_calculations.deleteMany({
      where: {
        created_at: {
          lt: cutoffDate,
        },
      },
    });

    if (process.env.NODE_ENV === "development") {
      console.log(
        `🗑️ Cleaned up ${deleted.count} old margin calculations (older than ${daysToKeep} days)`
      );
    }

    return deleted.count;
  }

  /**
   * Utility delay function
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Singleton instance
export const marginCalculatorService = new MarginCalculatorService();
