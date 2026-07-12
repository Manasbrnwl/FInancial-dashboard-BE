import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";
import { devError, prodError } from "../utils/errorLogger";

/**
 * Global Express error-handling middleware.
 * - Always logs the full error server-side.
 * - In production: returns a generic message to the client.
 * - In development: returns error.message + stack for debugging.
 */
export const globalErrorHandler = (
    err: any,
    _req: Request,
    res: Response,
    _next: NextFunction
) => {
    const statusCode = err.statusCode || 500;
    const isProduction = process.env.NODE_ENV === "production";

    // Always log full error details server-side
    devError("Unhandled error:", err);
    prodError("Unhandled server error");

    res.status(statusCode).json({
        success: false,
        message: isProduction
            ? "An unexpected error occurred"
            : err.message || "An unexpected error occurred",
        ...(!isProduction && { stack: err.stack }),
    });
};
