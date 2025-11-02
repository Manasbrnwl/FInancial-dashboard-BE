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
        time:string;
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
    TO_CHAR(te.time, 'yyyy-mm-dd HH12:MI AM') time,
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
  WHERE sl.segment = 'FUT' and sl.expiry_date >= CURRENT_DATE
  GROUP BY il.id, il.instrument_type, te.ltp, te.time
  ORDER BY il.instrument_type
`;

    // Transform the data to the desired format
    const transformedData = rawData.map((item) => {
      const symbols = item.symbols || [];

      return {
        instrumentId: item.instrumentid,
        underlyingSymbol: item.instrument_type,
        underlyingPrice: parseFloat(item.price),
        time: item.time,
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

export const getNSEOptionsData = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.query;

    if (!instrumentId) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId query parameter is required',
      });
    }

    const instrumentIdNum = parseInt(instrumentId as string);

    if (isNaN(instrumentIdNum)) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId must be a valid number',
      });
    }

    const optionsData = await prisma.$queryRaw<
      Array<{
        symbol: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        oi: number;
        expiry_date: Date;
        option_type: string;
      }>
    >`
      SELECT DISTINCT
        opt.symbol,
        opt.open,
        opt.high,
        opt.low,
        opt.close,
        opt.volume,
        opt.oi,
        opt.expiry_date,
        opt.option_type
      FROM market_data.nse_options opt
      INNER JOIN market_data.symbols_list li ON opt.symbol = li.symbol
      WHERE opt.expiry_date >= CURRENT_DATE
        AND li.instrument_id = ${instrumentIdNum}
      ORDER BY opt.expiry_date ASC
    `;

    res.json({
      success: true,
      data: optionsData,
      count: optionsData.length,
    });
  } catch (error: any) {
    console.error("Error fetching NSE Options data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE Options data",
      message: error.message,
    });
  }
}

export const getNSEFuturesData = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.query;

    if (!instrumentId) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId query parameter is required',
      });
    }

    const instrumentIdNum = parseInt(instrumentId as string);

    if (isNaN(instrumentIdNum)) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId must be a valid number',
      });
    }

    const futuresData = await prisma.$queryRaw<
      Array<{
        symbol: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        oi: number;
        expiry_date: Date;
      }>
    >`
      SELECT DISTINCT
        fut.symbol,
        fut.open,
        fut.high,
        fut.low,
        fut.close,
        fut.volume,
        fut.oi,
        fut.expiry_date
      FROM market_data.nse_futures fut
      INNER JOIN market_data.symbols_list li ON fut.symbol = li.symbol
      WHERE fut.expiry_date >= CURRENT_DATE
        AND li.instrument_id = ${instrumentIdNum}
      ORDER BY fut.expiry_date ASC
    `;

    res.json({
      success: true,
      data: futuresData,
      count: futuresData.length,
    });
  } catch (error: any) {
    console.error("Error fetching NSE Futures data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE Futures data",
      message: error.message,
    });
  }
}

export const getNSEFuturesTicksData = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.query;

    if (!instrumentId) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId query parameter is required',
      });
    }

    const instrumentIdNum = parseInt(instrumentId as string);

    if (isNaN(instrumentIdNum)) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId must be a valid number',
      });
    }

    const futuresTicksData = await prisma.$queryRaw<
      Array<{
        symbol: string;
        ltp: string;
        volume: string;
        oi: string;
        bid: string;
        bidqty: string;
        ask: string;
        askqty: string;
        expiry_date: Date;
      }>
    >`
      SELECT DISTINCT
        li.symbol,
        fut.ltp,
        fut.volume,
        fut.oi,
        fut.bid,
        fut.bidqty,
        fut.ask,
        fut.askqty,
        li.expiry_date
      FROM periodic_market_data."ticksDataNSEFUT" fut
      INNER JOIN market_data.symbols_list li ON fut."instrumentId" = li.id
      WHERE li.expiry_date >= CURRENT_DATE
        AND li.instrument_id = ${instrumentIdNum}
        AND li.segment = 'FUT'
      ORDER BY li.expiry_date ASC
    `;

    res.json({
      success: true,
      data: futuresTicksData,
      count: futuresTicksData.length,
    });
  } catch (error: any) {
    console.error("Error fetching NSE Futures Ticks data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE Futures Ticks data",
      message: error.message,
    });
  }
}

export const getNSEOptionsTicksData = async (req: Request, res: Response) => {
  try {
    const { instrumentId } = req.query;

    if (!instrumentId) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId query parameter is required',
      });
    }

    const instrumentIdNum = parseInt(instrumentId as string);

    if (isNaN(instrumentIdNum)) {
      return res.status(400).json({
        success: false,
        error: 'instrumentId must be a valid number',
      });
    }

    const optionsTicksData = await prisma.$queryRaw<
      Array<{
        symbol: string;
        ltp: string;
        volume: string;
        oi: string;
        bid: string;
        bidqty: string;
        ask: string;
        askqty: string;
        expiry_date: Date;
      }>
    >`
      SELECT DISTINCT
        li.symbol,
        opt.ltp,
        opt.volume,
        opt.oi,
        opt.bid,
        opt.bidqty,
        opt.ask,
        opt.askqty,
        li.expiry_date
      FROM periodic_market_data."ticksDataNSEOPT" opt
      INNER JOIN market_data.symbols_list li ON opt."instrumentId" = li.id
      WHERE li.expiry_date >= CURRENT_DATE
        AND li.instrument_id = ${instrumentIdNum}
        AND li.segment = 'OPT'
      ORDER BY li.expiry_date ASC
    `;

    res.json({
      success: true,
      data: optionsTicksData,
      count: optionsTicksData.length,
    });
  } catch (error: any) {
    console.error("Error fetching NSE Options Ticks data:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch NSE Options Ticks data",
      message: error.message,
    });
  }
}
