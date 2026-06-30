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
