import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

interface EquityRow {
  id: number;
  instrument_type: string;
  exchange: string;
}

interface SymbolRow {
  id: number;
  symbol: string;
  segment: string | null;
  expiry_date: Date | null;
  strike: string | null;
  option_type: string | null;
  expiry_month: string | null;
}

export const getEquitiesWithDerivatives = async (
  req: Request,
  res: Response
) => {
  try {
    const equities = await prisma.$queryRaw<EquityRow[]>`
      SELECT il.id, il.instrument_type, il.exchange
      FROM market_data.instrument_lists il
      WHERE EXISTS (
        SELECT 1
        FROM market_data.symbols_list sl
        WHERE sl.instrument_id = il.id
          AND sl.segment IN ('FUT','OPT')
      )
      ORDER BY il.instrument_type ASC
    `;

    res.json({
      success: true,
      data: equities.map((equity) => ({
        id: equity.id,
        instrumentType: equity.instrument_type,
        exchange: equity.exchange,
      })),
    });
  } catch (error: any) {
    console.error("Error fetching equities with derivatives:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch equities",
      error: error.message,
    });
  }
};

export const getSymbolsForEquity = async (req: Request, res: Response) => {
  const instrumentId = Number(req.params.instrumentId);

  if (!instrumentId || Number.isNaN(instrumentId)) {
    return res.status(400).json({
      success: false,
      message: "instrumentId must be a valid number",
    });
  }

  try {
    const symbols = await prisma.$queryRaw<SymbolRow[]>`
      SELECT id, symbol, segment, expiry_date, strike, option_type, expiry_month
      FROM market_data.symbols_list
      WHERE instrument_id = ${instrumentId}
        AND segment IN ('FUT','OPT')
        AND expiry_date > CURRENT_DATE
      ORDER BY segment ASC, expiry_date DESC NULLS LAST, symbol ASC
    `;

    res.json({
      success: true,
      data: symbols.map((row) => ({
        id: row.id,
        symbol: row.symbol,
        segment: row.segment,
        expiryDate: row.expiry_date,
        strike: row.strike,
        optionType: row.option_type,
        expiryMonth: row.expiry_month,
      })),
    });
  } catch (error: any) {
    console.error("Error fetching symbols for equity:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch symbols for equity",
      error: error.message,
    });
  }
};
