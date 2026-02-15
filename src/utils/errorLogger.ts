import { logger } from "./logger";

// Helper functions for dev-only logging
const isDev = process.env.NODE_ENV === 'development';
export const devLog = (...args: any[]) => { if (isDev) logger.info(...args); };
export const devWarn = (...args: any[]) => { if (isDev) logger.warn(...args); };
export const devError = (...args: any[]) => { if (isDev) logger.error(...args); };

const isProd = process.env.NODE_ENV === 'production';
export const prodLog = (...args: any[]) => { if (isProd) logger.info(...args); };
export const prodWarn = (...args: any[]) => { if (isProd) logger.warn(...args); };
export const prodError = (...args: any[]) => { if (isProd) logger.error(...args); };