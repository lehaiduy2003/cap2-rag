/**
 * Authentication Middleware
 * API Key validation for RAG service endpoints
 */

import { Request, Response, NextFunction } from "express";

/**
 * Middleware to validate API key from request headers
 * Expects: Authorization: Bearer <API_KEY> or X-API-Key: <API_KEY>
 */
export function validateApiKey(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health check
  if (req.path === "/health" || req.path === "/") {
    return next();
  }

  const apiKey = process.env.API_KEY;

  // If no API key is configured, allow all requests (development mode)
  if (!apiKey) {
    console.warn("[Auth] No API_KEY configured - authentication disabled");
    return next();
  }

  // Check X-API-Key header
  const apiKeyHeader = req.headers["x-api-key"];
  if (apiKeyHeader === apiKey) {
    return next();
  }

  // Unauthorized
  console.warn(`[Auth] Unauthorized access attempt from ${req.ip} to ${req.path}`);
  res.status(401).json({
    error: "Unauthorized",
    message: "Valid API key required. Use Authorization: Bearer <API_KEY> or X-API-Key: <API_KEY>",
  });
}

/**
 * Middleware to log all requests
 */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`
    );
  });

  next();
}

/**
 * Middleware to extract and validate owner/property context from request
 */
export function extractKBContext(req: Request, _res: Response, next: NextFunction): void {
  // Extract from body for POST requests
  if (req.method === "POST" && req.body) {
    req.body.owner_id = req.body.owner_id || req.query.owner_id;
    req.body.property_id = req.body.property_id || req.query.property_id;
  }

  // Extract from query for GET requests
  if (req.method === "GET" && req.query) {
    (req as any).kbContext = {
      owner_id: req.query.owner_id,
      property_id: req.query.property_id,
      kb_scope: req.query.kb_scope || "property",
    };
  }

  next();
}
