/**
 * RAG Service - Standalone Microservice
 * Handles document processing, embedding generation, and RAG chat
 */

import path from "path";
import dotenv from "dotenv";
import express, { Request, Response, NextFunction } from "express";
import { Pool } from "pg";
import cors from "cors";
import { createElasticsearchIndex, checkHealth } from "./elasticsearchClient";
import { initializeEmbeddingModel } from "./service/documentService";
import { createRAGRoutes } from "./routes";
import { validateApiKey, requestLogger, extractKBContext } from "./middleware/auth";

dotenv.config({ path: path.join(__dirname, "../.env") });

// Initialize Express app
const app = express();
const PORT = parseInt(process.env.PORT || "3001");

// Database configuration
const dbConfig = {
  user: process.env.PGUSER,
  host: process.env.PGHOST,
  database: process.env.PGDATABASE,
  password: process.env.PGPASSWORD,
  port: parseInt(process.env.PGPORT || "5432", 10),
};

// Create database pool
const pool = new Pool(dbConfig);
pool.on("error", (err: Error) => {
  console.error("[RAG Service] Database pool error:", err.message);
});

// Initialize RAG system components
async function initializeRAGSystem(): Promise<boolean> {
  try {
    console.log("[RAG Service] Initializing...");

    // Test database connection
    const client = await pool.connect();
    console.log("[RAG Service] Database connected successfully");
    client.release();

    // Check Elasticsearch health
    const esHealth = await checkHealth();
    if (esHealth) {
      console.log(
        "[RAG Service] Elasticsearch is healthy:",
        esHealth.cluster_name || esHealth.name || "Connected"
      );

      // Create Elasticsearch index
      await createElasticsearchIndex();
    } else {
      console.warn("[RAG Service] Elasticsearch is not available. Vector search will be limited.");
    }

    // Initialize embedding model (this may take a few minutes on first run)
    console.log("[RAG Service] Loading embedding model...");
    await initializeEmbeddingModel();
    console.log("[RAG Service] Embedding model loaded successfully");

    console.log("[RAG Service] Initialization complete");
    return true;
  } catch (error) {
    console.error("[RAG Service] Initialization error:", (error as Error).message);
    console.warn("[RAG Service] Some features may not work properly");
    return false;
  }
}

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Request logging
app.use(requestLogger);

// API Key authentication (applied globally, but skips /health and /)
app.use(validateApiKey);

// Extract KB context from requests
app.use(extractKBContext);

// Mount RAG routes
const ragRoutes = createRAGRoutes(pool);
app.use("/api", ragRoutes);

// Health check endpoint (no auth required)
app.get("/health", async (_req: Request, res: Response) => {
  try {
    // Check database
    const dbCheck = await pool.query("SELECT 1");
    const dbStatus = dbCheck ? "connected" : "disconnected";

    // Check Elasticsearch
    const esHealth = await checkHealth();
    const esStatus = esHealth
      ? esHealth.cluster_name || esHealth.name || "connected"
      : "disconnected";

    res.json({
      status: "running",
      service: "RAG Service",
      timestamp: new Date().toISOString(),
      database: dbStatus,
      elasticsearch: esStatus,
      version: "1.0.0",
    });
  } catch (error) {
    console.error("[RAG Service] Health check error:", (error as Error).message);
    res.status(500).json({
      status: "error",
      error: (error as Error).message,
    });
  }
});

// Root endpoint
app.get("/", (_req: Request, res: Response) => {
  res.json({
    service: "RAG Service",
    version: "1.0.0",
    description: "Retrieval Augmented Generation API",
    endpoints: {
      health: "GET /health",
      documents: {
        upload: "POST /api/documents/upload",
        list: "GET /api/documents",
        get: "GET /api/documents/:id",
        delete: "DELETE /api/documents/:id",
      },
      search: "POST /api/search",
      chat: {
        createSession: "POST /api/chat/sessions",
        getHistory: "GET /api/chat/sessions/:sessionId",
        sendMessage: "POST /api/chat",
        streamMessage: "POST /api/chat/stream",
        simpleQuery: "POST /api/query",
        deleteSession: "DELETE /api/chat/sessions/:sessionId",
      },
    },
  });
});

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("[RAG Service] Error:", err.message);
  res.status(500).json({
    error: "Internal server error",
    message: err.message,
  });
});

// Start server
async function startServer(): Promise<void> {
  try {
    // Initialize system first
    await initializeRAGSystem();

    // Start listening
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`[RAG Service] Server running on port ${PORT}`);
      console.log(`[RAG Service] Database: ${dbConfig.database} on ${dbConfig.host}`);
      console.log(`[RAG Service] Ready to accept requests`);
    });
  } catch (error) {
    console.error("[RAG Service] Failed to start server:", (error as Error).message);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[RAG Service] SIGTERM received, shutting down gracefully...");
  await pool.end();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[RAG Service] SIGINT received, shutting down gracefully...");
  await pool.end();
  process.exit(0);
});

// Start the server
startServer();

export default app;
