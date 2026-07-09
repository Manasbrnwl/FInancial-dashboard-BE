import prisma from "../config/prisma";
import { devLog } from "../utils/errorLogger";

const nameCache = new Map<number, string>();
const upstoxIdCache = new Map<number, string>();

/**
 * Get instrument name by ID with in-memory caching.
 */
export async function getInstrumentName(id: number): Promise<string> {
  if (nameCache.has(id)) return nameCache.get(id)!;

  const inst = await prisma.instrument_lists.findUnique({
    where: { id },
    select: { instrument_type: true }
  });

  if (inst) {
    nameCache.set(id, inst.instrument_type);
    return inst.instrument_type;
  }
  return "Unknown";
}

/**
 * Preload cache to avoid initial lookups.
 */
export async function preloadInstrumentCache(): Promise<void> {
  devLog("?? Preloading instrument cache...");
  const instruments = await prisma.instrument_lists.findMany({
    select: { id: true, instrument_type: true, upstox_id: true }
  });

  instruments.forEach(inst => {
    nameCache.set(inst.id, inst.instrument_type);
    if (inst.upstox_id) upstoxIdCache.set(inst.id, inst.upstox_id);
  });
  devLog(`✅ Cached ${instruments.length} instruments.`);
}

export function getCachedName(id: number): string {
  return nameCache.get(id) || "Unknown";
}
