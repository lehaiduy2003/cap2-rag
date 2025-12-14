import { Router } from "express";
import { Pool } from "pg";
import { createDocumentRoutes } from "./routes/documentRoutes";
import { createRetrievalRoutes } from "./routes/retrievalRoutes";
import { createChatRoutes } from "./routes/chatRoutes";

/**
 * Create RAG routes
 */
export function createRAGRoutes(pool: Pool): Router {
  const router = Router();

  // Mount sub-routes
  router.use("/documents", createDocumentRoutes(pool));
  router.use("/search", createRetrievalRoutes());
  router.use("/retrieve", createRetrievalRoutes());
  router.use("/chat", createChatRoutes());

  return router;
}
