import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export const getArbitrageData = async (req: Request, res: Response) => {
  try {
    const rawData = await prisma.$queryRaw<
      Array<{
        instrumentid: number;
        instrument_type: string;
        price: string;
        symbols: any;
      }>
    >`
  WITH latest_tick_fut AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY "instrumentId" ORDER BY id DESC) rn
    FROM periodic_market_data."ticksDataNSEFUT"
  ), latest_tick_eq AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY "instrumentId" ORDER BY id DESC) rn
    FROM periodic_market_data."ticksDataNSEEQ"
  )
  SELECT
    il.id AS instrumentid,
    il.instrument_type,
    te.ltp AS price,
    json_agg(
      json_build_object(
        'expiry_date', sl.expiry_date,
        'symbol', sl.symbol,
        'ltp', tf.ltp,
        'volume', tf.volume
      ) ORDER BY sl.expiry_date
    ) AS symbols
  FROM market_data.symbols_list sl
  INNER JOIN market_data.instrument_lists il
    ON sl.instrument_id = il.id
  INNER JOIN latest_tick_fut tf
    ON sl.id = tf."instrumentId" AND tf.rn = 1
  INNER JOIN latest_tick_eq te
    ON sl.instrument_id = te."instrumentId" AND te.rn = 1
  WHERE sl.segment = 'FUT'
  GROUP BY il.id, il.instrument_type, te.ltp
  ORDER BY il.instrument_type
`;

    // Transform the data to the desired format
    const transformedData = rawData.map((item) => {
      const symbols = item.symbols || [];

      return {
        underlyingSymbol: item.instrument_type,
        underlyingPrice: parseFloat(item.price),
        nearFutureSymbol: symbols[0]?.symbol || null,
        nearFuturePrice: symbols[0]?.ltp ? parseFloat(symbols[0].ltp) : null,
        nearFutureVolume: symbols[0]?.volume
          ? parseInt(symbols[0].volume)
          : null,
        nextFutureSymbol: symbols[1]?.symbol || null,
        nextFuturePrice: symbols[1]?.ltp ? parseFloat(symbols[1].ltp) : null,
        nextFutureVolume: symbols[1]?.volume
          ? parseInt(symbols[1].volume)
          : null,
        farFutureSymbol: symbols[2]?.symbol || null,
        farFuturePrice: symbols[2]?.ltp ? parseFloat(symbols[2].ltp) : null,
        farFutureVolume: symbols[2]?.volume
          ? parseInt(symbols[2].volume)
          : null,
      };
    });

    res.json({
      success: true,
      data: transformedData,
    });
  } catch (error: any) {
    console.error("Error fetching Arbitrage data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch Arbitrage data",
      message: error.message,
    });
  }
};
