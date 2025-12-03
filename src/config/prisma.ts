import { PrismaClient } from "@prisma/client";

const globalForPrisma = global as unknown as {
  prisma?: PrismaClient;
};

const logQueries = process.env.PRISMA_LOG_QUERIES === "true";
const slowThreshold = Number(process.env.PRISMA_SLOW_QUERY_MS || 500);

const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: logQueries ? ["query", "warn", "error"] : ["warn", "error"],
  });

// Middleware typing differs by Prisma version; gate with in-operator to avoid TS complaints.
if (logQueries && Number.isFinite(slowThreshold) && slowThreshold > 0 && "$use" in prisma) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma as any).$use(async (params: any, next: any) => {
    const start = Date.now();
    const result = await next(params);
    const duration = Date.now() - start;
    if (duration >= slowThreshold) {
      console.warn(
        `[prisma:slow ${duration}ms] ${params.model || "raw"}.${params.action}`
      );
    }
    return result;
  });
}

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export default prisma;
