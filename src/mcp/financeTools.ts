import { McpServer } from './sdk';
import { z } from 'zod';
import prisma from '../config/prisma';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(message: string) {
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true,
  };
}

/** Guard against non-positive limits. */
function safeLimit(limit: number): number {
  return Math.max(1, limit);
}

// ---------------------------------------------------------------------------
// MCP Server factory
// ---------------------------------------------------------------------------
export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'finance-dashboard', version: '1.0.0' },
    {
      instructions:
        'Read-only access to the Finance Dashboard market database. ' +
        'Data spans NSE equity, BSE equity, NSE futures, NSE options, covered call alerts, ' +
        'gap alerts, instrument lists, symbols, margin calculations, and intraday tick/OHLC data. ' +
        'All tools are strictly read-only — no writes, updates, or deletes are possible. ' +
        'Dates must be ISO-8601 strings (YYYY-MM-DD). Symbols are case-sensitive uppercase strings.',
    }
  );

  // -------------------------------------------------------------------------
  // 1. get_nse_equity
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_nse_equity',
    {
      description:
        'Fetch daily OHLCV data for an NSE equity symbol. Returns open, high, low, close, volume for each trading date.',
      inputSchema: {
        symbol:  z.string().describe('NSE equity symbol e.g. RELIANCE, INFY, NIFTY50'),
        from:    z.string().describe('Start date YYYY-MM-DD (inclusive)'),
        to:      z.string().describe('End date YYYY-MM-DD (inclusive)'),
        limit:   z.number().int().min(1).default(100).describe('Max rows to return'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ symbol, from, to, limit }: { symbol: string; from: string; to: string; limit: number }) => {
      try {
        const rows = await prisma.nse_equity.findMany({
          where: {
            symbol: symbol.toUpperCase(),
            date: { gte: new Date(from), lte: new Date(to) },
          },
          orderBy: { date: 'desc' },
          take: safeLimit(limit),
          select: { symbol: true, date: true, open: true, high: true, low: true, close: true, volume: true, oi: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 2. get_bse_equity
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_bse_equity',
    {
      description: 'Fetch daily OHLCV data for a BSE equity symbol.',
      inputSchema: {
        symbol: z.string().describe('BSE equity symbol e.g. RELIANCE, TCS'),
        from:   z.string().describe('Start date YYYY-MM-DD'),
        to:     z.string().describe('End date YYYY-MM-DD'),
        limit:  z.number().int().min(1).default(100).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ symbol, from, to, limit }: { symbol: string; from: string; to: string; limit: number }) => {
      try {
        const rows = await prisma.bse_equity.findMany({
          where: {
            symbol: symbol.toUpperCase(),
            date: { gte: new Date(from), lte: new Date(to) },
          },
          orderBy: { date: 'desc' },
          take: safeLimit(limit),
          select: { symbol: true, date: true, open: true, high: true, low: true, close: true, volume: true, oi: true, exchange: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 3. get_nse_futures
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_nse_futures',
    {
      description:
        'Fetch NSE futures OHLCV data. Filter by underlying instrument ID and optional expiry date.',
      inputSchema: {
        underlying: z.number().int().describe('Underlying instrument_id (integer)'),
        from:        z.string().describe('Start date YYYY-MM-DD'),
        to:          z.string().describe('End date YYYY-MM-DD'),
        expiry_date: z.string().optional().describe('Expiry date YYYY-MM-DD (optional filter)'),
        limit:       z.number().int().min(1).default(100).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ underlying, from, to, expiry_date, limit }: { underlying: number; from: string; to: string; expiry_date?: string; limit: number }) => {
      try {
        const rows = await prisma.nse_futures.findMany({
          where: {
            underlying,
            date: { gte: new Date(from), lte: new Date(to) },
            ...(expiry_date ? { expiry_date: new Date(expiry_date) } : {}),
          },
          orderBy: { date: 'desc' },
          take: safeLimit(limit),
          select: { symbol: true, date: true, open: true, high: true, low: true, close: true, volume: true, oi: true, underlying: true, expiry_date: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 4. get_nse_options
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_nse_options',
    {
      description:
        'Fetch NSE options OHLCV data. Filter by underlying, expiry, strike price, and option type (CE/PE). ' +
        'NOTE on `close`: for stock options (not index options like NIFTY/BANKNIFTY) this is NSE\'s official ' +
        'settlement/theoretical close -- a closing-window VWAP or model price, not necessarily a price that ' +
        'actually traded. On ~14-23% of stock-option bars (illiquid strikes) it falls outside that bar\'s own ' +
        '[low, high] range despite real volume. Correct for margin/P&L; do not treat it as an executable fill ' +
        'price. Index options are unaffected.',
      inputSchema: {
        underlying:  z.number().int().describe('Underlying instrument_id (integer)'),
        from:         z.string().describe('Start date YYYY-MM-DD'),
        to:           z.string().describe('End date YYYY-MM-DD'),
        expiry_date:  z.string().optional().describe('Expiry date YYYY-MM-DD'),
        strike:       z.string().optional().describe('Strike price as string e.g. "18000"'),
        option_type:  z.enum(['CE', 'PE']).optional().describe('Option type: CE or PE'),
        limit:        z.number().int().min(1).default(100).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ underlying, from, to, expiry_date, strike, option_type, limit }: { underlying: number; from: string; to: string; expiry_date?: string; strike?: string; option_type?: 'CE' | 'PE'; limit: number }) => {
      try {
        const rows = await prisma.nse_options.findMany({
          where: {
            underlying,
            date: { gte: new Date(from), lte: new Date(to) },
            ...(expiry_date  ? { expiry_date: new Date(expiry_date) } : {}),
            ...(strike       ? { strike } : {}),
            ...(option_type  ? { option_type } : {}),
          },
          orderBy: { date: 'desc' },
          take: safeLimit(limit),
          select: { symbol: true, date: true, open: true, high: true, low: true, close: true, volume: true, oi: true, underlying: true, expiry_date: true, strike: true, option_type: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 5. get_instruments
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_instruments',
    {
      description:
        'List instruments from instrument_lists. Filter by exchange (NSE/BSE) and/or instrument_type (e.g. NIFTY, BANKNIFTY). ' +
        'NOTE: BSE instruments were never registered in instrument_lists (an NSE/Upstox-oriented table) -- for ' +
        'exchange=BSE this falls back to the distinct symbols actually present in bse_equity, in a reduced shape ' +
        '(no upstox_id/upstox_symbol, since BSE data doesn\'t come via Upstox).',
      inputSchema: {
        exchange:        z.string().optional().describe('Exchange: NSE or BSE'),
        instrument_type: z.string().optional().describe('Instrument type string e.g. NIFTY, BANKNIFTY, FINNIFTY'),
        limit:           z.number().int().min(1).default(50).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ exchange, instrument_type, limit }: { exchange?: string; instrument_type?: string; limit: number }) => {
      try {
        const take = safeLimit(limit);
        const rows = await prisma.instrument_lists.findMany({
          where: {
            ...(exchange         ? { exchange }         : {}),
            ...(instrument_type  ? { instrument_type }  : {}),
          },
          take,
          select: { id: true, exchange: true, instrument_type: true, upstox_symbol: true, upstox_id: true },
          orderBy: { id: 'asc' },
        });

        if (rows.length > 0 || exchange?.toUpperCase() !== 'BSE') {
          return ok({ count: rows.length, rows });
        }

        // instrument_lists has nothing for BSE; fall back to bse_equity's own
        // distinct symbols rather than returning an empty result that looks
        // like "no BSE data exists" when it plainly does.
        const bseSymbols = await prisma.bse_equity.findMany({
          where: instrument_type ? { symbol: instrument_type } : {},
          distinct: ['symbol'],
          take,
          select: { symbol: true, symbol_id: true },
          orderBy: { symbol: 'asc' },
        });
        const fallbackRows = bseSymbols.map((s) => ({
          id: null,
          exchange: 'BSE',
          instrument_type: s.symbol,
          upstox_symbol: null,
          upstox_id: null,
          bse_symbol_id: s.symbol_id,
        }));
        return ok({ count: fallbackRows.length, rows: fallbackRows, source: 'bse_equity (instrument_lists has no BSE rows)' });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 6. get_symbols
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_symbols',
    {
      description:
        'List symbols from symbols_list for a given instrument. Useful for finding option strikes and expiry months.',
      inputSchema: {
        instrument_id: z.number().int().describe('Instrument ID from instrument_lists'),
        segment:       z.string().optional().describe('Segment: EQ, FUT, OPT'),
        expiry_month:  z.string().optional().describe('Expiry month string e.g. "2025-01"'),
        limit:         z.number().int().min(1).default(100).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrument_id, segment, expiry_month, limit }: { instrument_id: number; segment?: string; expiry_month?: string; limit: number }) => {
      try {
        const rows = await prisma.symbols_list.findMany({
          where: {
            instrument_id,
            ...(segment       ? { segment }       : {}),
            ...(expiry_month  ? { expiry_month }  : {}),
          },
          take: safeLimit(limit),
          select: { id: true, symbol: true, segment: true, expiry_date: true, strike: true, option_type: true, expiry_month: true },
          orderBy: { expiry_date: 'desc' },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 7. get_covered_call_alerts
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_covered_call_alerts',
    {
      description:
        'Fetch recent covered call alerts. Shows instruments triggering covered-call criteria (OTM %, premium %, upside).',
      inputSchema: {
        instrument_id: z.number().int().optional().describe('Filter by instrument ID (optional)'),
        from:          z.string().optional().describe('Start datetime YYYY-MM-DD (optional)'),
        limit:         z.number().int().min(1).default(50).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrument_id, from, limit }: { instrument_id?: number; from?: string; limit: number }) => {
      try {
        const rows = await prisma.covered_call_alerts.findMany({
          where: {
            ...(instrument_id ? { instrument_id } : {}),
            ...(from          ? { triggered_at: { gte: new Date(from) } } : {}),
          },
          orderBy: { triggered_at: 'desc' },
          take: safeLimit(limit),
          select: { id: true, instrument_id: true, instrument_name: true, symbol: true, strike: true, option_type: true, expiry_date: true, underlying_price: true, premium: true, otm_percent: true, premium_percent: true, max_upside: true, triggered_at: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 8. get_gap_alerts
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_gap_alerts',
    {
      description:
        'Fetch gap alerts — triggered when gap values deviate significantly from historical averages.',
      inputSchema: {
        instrument_id: z.number().int().optional().describe('Filter by instrument ID (optional)'),
        from:          z.string().optional().describe('Start datetime YYYY-MM-DD (optional)'),
        limit:         z.number().int().min(1).default(50).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrument_id, from, limit }: { instrument_id?: number; from?: string; limit: number }) => {
      try {
        const rows = await prisma.gap_alerts.findMany({
          where: {
            ...(instrument_id ? { instrument_id } : {}),
            ...(from          ? { triggered_at: { gte: new Date(from) } } : {}),
          },
          orderBy: { triggered_at: 'desc' },
          take: safeLimit(limit),
          select: { id: true, instrument_id: true, instrument_name: true, time_slot: true, alert_type: true, current_value: true, avg_value: true, deviation_percent: true, triggered_at: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 9. get_margin_calculations
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_margin_calculations',
    {
      description:
        'Fetch margin calculation history. Shows required span/exposure margin for past position assessments.',
      inputSchema: {
        security_id: z.string().optional().describe('Filter by security_id (optional)'),
        from:        z.string().optional().describe('Start date YYYY-MM-DD (optional)'),
        limit:       z.number().int().min(1).default(50).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ security_id, from, limit }: { security_id?: string; from?: string; limit: number }) => {
      try {
        const rows = await prisma.margin_calculations.findMany({
          where: {
            ...(security_id ? { security_id } : {}),
            ...(from        ? { created_at: { gte: new Date(from) } } : {}),
          },
          orderBy: { created_at: 'desc' },
          take: safeLimit(limit),
          select: { id: true, security_id: true, symbol: true, exchange_segment: true, transaction_type: true, quantity: true, product_type: true, price: true, total_margin: true, span_margin: true, exposure_margin: true, leverage: true, created_at: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 10. get_periodic_ohlc
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_periodic_ohlc',
    {
      description:
        'Fetch intraday (5-min) OHLC data for NSE instruments from the periodic_market_data schema. ' +
        'WARNING: the ohlcDataNSE table this reads from has not been populated since 2025-10-03 ' +
        '(~4k rows total) -- this will return nothing for any recent date. Use get_ticks for current ' +
        'intraday data instead; this tool is effectively unmaintained pending a decision to either fix ' +
        'the job that was supposed to feed it or deprecate it outright.',
      inputSchema: {
        instrument_id: z.number().int().describe('Instrument ID from instrument_lists'),
        from:          z.string().describe('Start datetime ISO-8601 e.g. 2025-01-15T09:15:00'),
        to:            z.string().describe('End datetime ISO-8601 e.g. 2025-01-15T15:30:00'),
        limit:         z.number().int().min(1).default(100).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrument_id: instrumentId, from, to, limit }: { instrument_id: number; from: string; to: string; limit: number }) => {
      try {
        const rows = await prisma.ohlcDataNSE.findMany({
          where: {
            instrumentId,
            time: { gte: new Date(from), lte: new Date(to) },
          },
          orderBy: { time: 'desc' },
          take: safeLimit(limit),
          select: { instrumentId: true, time: true, open: true, high: true, low: true, close: true, volume: true, oi: true },
        });
        return ok({ count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  // -------------------------------------------------------------------------
  // 11. get_ticks
  // -------------------------------------------------------------------------
  server.registerTool<any, any>(
    'get_ticks',
    {
      description:
        'Fetch tick-level data (LTP, bid, ask, volume, OI) for NSE instruments. Choose segment: EQ, FUT, or OPT. ' +
        'IMPORTANT: instrument_id means different things per segment -- see its description.',
      inputSchema: {
        instrument_id: z.number().int().describe(
          'For segment=EQ: an instrument_lists.id (the underlying, e.g. RELIANCE). ' +
          'For segment=FUT/OPT: a symbols_list.id (the specific contract, e.g. one expiry/strike) -- ' +
          'use get_symbols to find it, NOT instrument_lists.id. Passing an instrument_lists.id for FUT/OPT ' +
          'will silently return zero rows, since ticksDataNSEFUT/ticksDataNSEOPT key on the contract, not the underlying.'
        ),
        segment:       z.enum(['EQ', 'FUT', 'OPT']).describe('Market segment: EQ (equity), FUT (futures), OPT (options)'),
        from:          z.string().describe('Start datetime ISO-8601'),
        to:            z.string().describe('End datetime ISO-8601'),
        limit:         z.number().int().min(1).default(200).describe('Max rows'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ instrument_id: instrumentId, segment, from, to, limit }: { instrument_id: number; segment: 'EQ' | 'FUT' | 'OPT'; from: string; to: string; limit: number }) => {
      try {
        const timeFilter = { gte: new Date(from), lte: new Date(to) };
        const take = safeLimit(limit);
        const select = {
          instrumentId: true, time: true, ltp: true,
          volume: true, oi: true, bid: true, bidqty: true, ask: true, askqty: true,
        };

        let rows: unknown[];
        if (segment === 'EQ') {
          rows = await prisma.ticksDataNSEEQ.findMany({
            where: { instrumentId, time: timeFilter },
            orderBy: { time: 'desc' },
            take,
            select,
          });
        } else if (segment === 'FUT') {
          rows = await prisma.ticksDataNSEFUT.findMany({
            where: { instrumentId, time: timeFilter },
            orderBy: { time: 'desc' },
            take,
            select,
          });
        } else {
          rows = await prisma.ticksDataNSEOPT.findMany({
            where: { instrumentId, time: timeFilter },
            orderBy: { time: 'desc' },
            take,
            select,
          });
        }
        return ok({ segment, count: rows.length, rows });
      } catch (e: any) {
        return err(e.message);
      }
    }
  );

  return server;
}
