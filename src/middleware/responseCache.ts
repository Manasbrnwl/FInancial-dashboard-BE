import { Request, Response, NextFunction } from "express";

interface CacheEntry {
  body: unknown;
  expiresAt: number;
}

const store = new Map<string, CacheEntry>();

/**
 * Short-TTL in-memory cache for GET endpoints whose underlying data only
 * changes as often as the ingestion cron jobs run (every 5 min during market
 * hours). Keyed by full URL (path + query) — safe to share across users since
 * these endpoints return the same market data regardless of who's asking.
 */
export function cacheResponse(ttlSeconds: number) {
  const ttlMs = ttlSeconds * 1000;

  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "GET") return next();

    const key = req.originalUrl;
    const cached = store.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      res.setHeader("X-Cache", "HIT");
      res.json(cached.body);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode === 200) {
        store.set(key, { body, expiresAt: Date.now() + ttlMs });
      }
      res.setHeader("X-Cache", "MISS");
      return originalJson(body);
    };

    next();
  };
}
