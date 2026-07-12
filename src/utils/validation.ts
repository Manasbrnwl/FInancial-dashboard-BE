export function parseInteger(value: any, fallback: number): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseFloatNumber(value: any, fallback: number | null = null): number | null {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseLimitOffset(
  query: { limit?: any; offset?: any; page?: any },
  defaultLimit = 100
): { limit: number; offset: number; page: number } {
  const page = Math.max(parseInteger(query.page, 1), 1);
  const limit = Math.min(Math.max(parseInteger(query.limit, defaultLimit), 1), 1000);
  
  let offset = 0;
  if (query.offset !== undefined && query.offset !== null && query.offset !== "") {
    offset = Math.max(parseInteger(query.offset, 0), 0);
  } else {
    offset = (page - 1) * limit;
  }

  return { limit, offset, page };
}

export function isValidDateString(value: any): boolean {
  if (typeof value !== "string" || !value) {
    return false;
  }
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp);
}

const DEFAULT_DATE_RANGE_DAYS = 90;

/**
 * Builds a Prisma date-range filter from startDate/endDate query params.
 * nse_equity/nse_futures/nse_options/bse_equity are TimescaleDB hypertables
 * with hundreds of (mostly compressed) chunks. A query with no date bound
 * forces Postgres to lock every chunk, which exhausts max_locks_per_transaction
 * ("out of shared memory"). When the caller gives no date bound at all,
 * default to a trailing window instead of leaving the query unbounded.
 */
export function parseDateRange(
  query: { startDate?: any; endDate?: any },
  defaultRangeDays = DEFAULT_DATE_RANGE_DAYS
): { gte?: Date; lte?: Date } {
  const { startDate, endDate } = query;

  if (!startDate && !endDate) {
    const gte = new Date();
    gte.setDate(gte.getDate() - defaultRangeDays);
    return { gte };
  }

  const range: { gte?: Date; lte?: Date } = {};
  if (startDate) range.gte = new Date(startDate as string);
  if (endDate) range.lte = new Date(endDate as string);
  return range;
}
