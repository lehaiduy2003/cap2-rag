/**
 * Document Management Routes
 * Handles all document-related API endpoints
 */

import { Router, Request, Response } from "express";
import { Pool } from "pg";
import { getDocuments, processDocumentFromUrl } from "../service/documentService";
import { deleteDocumentChunks } from "../elasticsearchClient";
import { getDocumentContext } from "../ragRetrieval";

/**
 * Create document management routes
 */
export function createDocumentRoutes(pool: Pool): Router {
  const router = Router();

  /**
   * POST /api/documents/process-url
   * Process a document from URL and update VAT service
   */
  router.post("/process-url", async (req: Request, res: Response): Promise<any> => {
    try {
      const { document_id, upload_url, vat_service_url, vat_api_key, metadata } = req.body;

      if (!document_id || !upload_url || !vat_service_url) {
        return res.status(400).json({
          error: "document_id, upload_url, and vat_service_url are required",
        });
      }

      console.log(`[RAG API] Starting processing for document ${document_id} from ${upload_url}`);

      await processDocumentFromUrl(document_id, upload_url, vat_service_url, vat_api_key, metadata);

      res.json({
        success: true,
        message: "Document processed successfully",
        document_id,
      });
    } catch (error) {
      console.error("[RAG API] Error starting document processing:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * GET /api/rag/documents
   * Get list of documents
   */
  router.get("/", async (req: Request, res: Response) => {
    try {
      const filters = {
        status: req.query.status as string,
        uploaded_by: req.query.uploaded_by as string,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
      };

      const documents = await getDocuments(filters);
      res.json({ documents });
    } catch (error) {
      console.error("[RAG API] Error getting documents:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * GET /api/rag/documents/:id
   * Get document details with chunks
   */
  router.get("/:id", async (req: Request, res: Response): Promise<any> => {
    try {
      const documentId = parseInt(req.params.id);

      // Get document info
      const docResult = await pool.query("SELECT * FROM documents WHERE id = $1", [documentId]);

      if (docResult.rows.length === 0) {
        return res.status(404).json({ error: "Document not found" });
      }

      const document = docResult.rows[0];

      // Get chunks from Elasticsearch
      const chunks = await getDocumentContext(documentId, {
        maxChunks: 100,
      });

      res.json({
        document,
        chunks,
        chunk_count: chunks.length,
      });
    } catch (error) {
      console.error("[RAG API] Error getting document:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * DELETE /api/rag/documents/:id
   * Delete a document and all its chunks from Elasticsearch
   */
  router.delete("/:id", async (req: Request, res: Response): Promise<any> => {
    try {
      const documentId = parseInt(req.params.id);

      if (isNaN(documentId)) {
        return res.status(400).json({ error: "Invalid document ID" });
      }

      console.log(`[RAG API] Deleting document ${documentId} and all associated chunks...`);

      // Delete all chunks from Elasticsearch (handles semantic chunks automatically)
      // The deleteDocumentChunks uses _delete_by_query to remove ALL chunks with matching document_id
      const deletionResult = await deleteDocumentChunks(documentId);
      const deletedChunks = deletionResult?.deleted || 0;

      console.log(
        `[RAG API] Deleted ${deletedChunks} chunks from Elasticsearch for document ${documentId}`
      );

      return res.json({
        success: true,
        message: `Document deleted successfully. Removed ${deletedChunks} chunk(s) from Elasticsearch.`,
        deleted_chunks: deletedChunks,
        document_id: documentId,
      });
    } catch (error) {
      console.error("[RAG API] Error deleting document:", (error as Error).message);
      return res.status(500).json({
        error: (error as Error).message,
        message: "Failed to delete document and chunks",
      });
    }
  });

  return router;
}
