/**
 * Retrieval and Search Routes
 * Handles search and retrieval API endpoints
 */

import { Router, Request, Response } from "express";
import { retrieveRelevantChunks, searchWithFilters } from "../ragRetrieval";

/**
 * Create retrieval and search routes
 */
export function createRetrievalRoutes(): Router {
  const router = Router();

  /**
   * POST /api/rag/search
   * Search for relevant chunks with optional filters
   */
  router.post("/search", async (req: Request, res: Response): Promise<any> => {
    try {
      const { query, top_k, filters } = req.body;

      if (!query) {
        return res.status(400).json({ error: "Query is required" });
      }

      let results;
      if (filters && Object.keys(filters).length > 0) {
        results = await searchWithFilters(query, {
          ...filters,
          topK: top_k || 5,
        });
      } else {
        results = await retrieveRelevantChunks(query, {
          topK: top_k || 5,
        });
      }

      res.json({ results });
    } catch (error) {
      console.error("[RAG API] Error searching:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /api/rag/retrieve
   * Retrieve context chunks for a query (for model-vat to use in chat)
   * Filters by owner_id and/or property_id for property-specific KB
   */
  router.post("/retrieve", async (req: Request, res: Response): Promise<any> => {
    try {
      const { query, top_k, search_type, min_score, rerank, owner_id, property_id, kb_scope } =
        req.body;

      if (!query) {
        return res.status(400).json({ error: "Query is required" });
      }

      // Validate KB scope - must provide owner_id for property/owner scope
      if ((kb_scope === "property" || kb_scope === "owner") && !owner_id) {
        return res.status(400).json({ error: "owner_id is required for property/owner KB scope" });
      }

      const chunks = await retrieveRelevantChunks(query, {
        topK: top_k || 5,
        searchType: search_type || "hybrid",
        minScore: min_score || 0.7,
        rerank: rerank !== false,
        ownerId: owner_id,
        propertyId: property_id,
        kbScope: kb_scope || "property",
      });

      res.json({
        query,
        chunks,
        count: chunks.length,
      });
    } catch (error) {
      console.error("[RAG API] Error retrieving context:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}
