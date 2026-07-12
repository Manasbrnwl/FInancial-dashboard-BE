import logger from './logger';

/**
 * @deprecated Use logger directly (e.g., logger.debug, logger.info)
 */
export const devLog = (...args: any[]) => logger.debug(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));

/**
 * @deprecated Use logger.warn
 */
export const devWarn = (...args: any[]) => logger.warn(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));

/**
 * @deprecated Use logger.error
 */
export const devError = (...args: any[]) => logger.error(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));

/**
 * @deprecated Use logger.info
 */
export const prodLog = (...args: any[]) => logger.info(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));

/**
 * @deprecated Use logger.warn
 */
export const prodWarn = (...args: any[]) => logger.warn(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));

/**
 * @deprecated Use logger.error
 */
export const prodError = (...args: any[]) => logger.error(args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' '));