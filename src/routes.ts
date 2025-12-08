import { Router, Request, Response } from "express";
import { Pool } from "pg";
import multer from "multer";
import {
  saveDocument,
  processDocument,
  extractTextFromFile,
  deleteDocument,
  getDocuments,
} from "./documentService";
import { bulkIndexChunks, deleteDocumentChunks } from "./elasticsearchClient";
import { retrieveRelevantChunks, getDocumentContext, searchWithFilters } from "./ragRetrieval";

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = [
      "text/plain",
      "text/markdown",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
      "application/msword", // .doc (legacy)
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type not supported: ${file.mimetype}`));
    }
  },
});

/**
 * Create RAG routes
 */
export function createRAGRoutes(pool: Pool): Router {
  const router = Router();

  // ===== DOCUMENT MANAGEMENT ENDPOINTS =====

  /**
   * POST /api/rag/documents/process
   * Process a document stored in model-vat service
   */
  router.post("/documents/process", async (req: Request, res: Response): Promise<any> => {
    try {
      const { document_id, model_vat_url, chunk_size, overlap } = req.body;

      if (!document_id || !model_vat_url) {
        return res.status(400).json({ error: "document_id and model_vat_url are required" });
      }

      console.log(`[RAG API] Processing document ${document_id} from model-vat...`);

      // Fetch document metadata from model-vat
      const axios = require("axios");
      const metadataUrl = `${model_vat_url}/api/v1/documents/${document_id}/metadata`;
      const fileUrl = `${model_vat_url}/api/v1/documents/${document_id}/file`;

      const metadataResponse = await axios.get(metadataUrl, {
        headers: {
          "x-api-key": process.env.API_KEY || process.env.RAG_API_KEY,
        },
      });

      const metadata = metadataResponse.data;

      // Fetch file content
      const fileResponse = await axios.get(fileUrl, {
        headers: {
          "x-api-key": process.env.API_KEY || process.env.RAG_API_KEY,
        },
        responseType: "arraybuffer",
      });

      const fileBuffer = Buffer.from(fileResponse.data);

      // Create a temporary file-like object
      const fileData = {
        originalname: metadata.filename,
        buffer: fileBuffer,
        mimetype: metadata.content_type,
        size: metadata.file_size,
      };

      // Save document metadata in RAG database
      const docMetadata = {
        title: metadata.title,
        uploaded_by: metadata.owner_id?.toString() || "system",
        owner_id: metadata.owner_id?.toString(),
        property_id: metadata.property_id,
        kb_scope: metadata.kb_scope || "owner",
        chunk_size: chunk_size || 500,
        overlap: overlap || 50,
        content_type: metadata.content_type,
      };

      const { documentId, filePath } = await saveDocument(pool, fileData, docMetadata);

      // Extract text from the saved file
      const fullText = await extractTextFromFile(filePath, metadata.content_type);

      // Process document (chunk and embed)
      const chunkRecords = await processDocument(pool, documentId, fullText, docMetadata);

      // Get document details for Elasticsearch
      const docResult = await pool.query(
        "SELECT title, owner_id, property_id FROM documents WHERE id = $1",
        [documentId]
      );
      const doc = docResult.rows[0];

      // Index in Elasticsearch
      const esChunks = chunkRecords.map((chunk) => ({
        chunk_id: chunk.chunk_id,
        document_id: chunk.document_id,
        document_title: doc?.title || "Untitled",
        chunk_text: chunk.chunk_text,
        chunk_index: chunk.chunk_index,
        owner_id: doc?.owner_id,
        property_id: doc?.property_id,
        embedding: chunk.embedding,
        created_at: new Date().toISOString(),
      }));

      await bulkIndexChunks(esChunks);

      // Mark chunks as indexed
      const chunkIds = chunkRecords.map((c) => c.chunk_id);
      await pool.query("UPDATE document_chunks SET es_indexed = TRUE WHERE id = ANY($1)", [
        chunkIds,
      ]);

      console.log(`[RAG API] Successfully processed document ${document_id}`);

      res.json({
        success: true,
        document_id: documentId,
        chunk_count: chunkRecords.length,
        message: "Document processed successfully",
      });
    } catch (error) {
      console.error("[RAG API] Error processing document:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * POST /api/rag/documents/upload
   * Upload a new document
   */
  router.post(
    "/documents/upload",
    upload.single("file"),
    async (req: Request, res: Response): Promise<any> => {
      try {
        if (!req.file) {
          return res.status(400).json({ error: "No file uploaded" });
        }

        const metadata = {
          title: req.body.title || req.file.originalname,
          uploaded_by: req.body.uploaded_by || "anonymous",
          owner_id: req.body.owner_id, // Property owner ID
          property_id: req.body.property_id ? parseInt(req.body.property_id) : undefined, // Property ID
          kb_scope: req.body.kb_scope || "property", // 'property', 'owner', 'global'
          chunk_size: parseInt(req.body.chunk_size) || 500,
          overlap: parseInt(req.body.overlap) || 50,
          ...JSON.parse(req.body.metadata || "{}"),
        };

        // Validate required fields for property KB
        if (!metadata.owner_id) {
          return res.status(400).json({ error: "owner_id is required" });
        }

        // Save document
        const { documentId, filePath } = await saveDocument(pool, req.file, metadata);

        // Extract text from file
        const fullText = await extractTextFromFile(filePath, req.file.mimetype);

        // Process document (chunk and embed) in background
        processDocument(pool, documentId, fullText, metadata)
          .then(async (chunkRecords) => {
            // Get document details for Elasticsearch
            const docResult = await pool.query(
              "SELECT title, owner_id, property_id FROM documents WHERE id = $1",
              [documentId]
            );
            const doc = docResult.rows[0];

            // Index in Elasticsearch with embeddings and owner/property info
            const esChunks = chunkRecords.map((chunk) => ({
              chunk_id: chunk.chunk_id,
              document_id: chunk.document_id,
              document_title: doc?.title || "Untitled",
              chunk_text: chunk.chunk_text,
              chunk_index: chunk.chunk_index,
              owner_id: doc?.owner_id,
              property_id: doc?.property_id,
              embedding: chunk.embedding,
              created_at: new Date().toISOString(),
            }));

            await bulkIndexChunks(esChunks);

            // Mark chunks as indexed in PostgreSQL
            const chunkIds = chunkRecords.map((c) => c.chunk_id);
            await pool.query("UPDATE document_chunks SET es_indexed = TRUE WHERE id = ANY($1)", [
              chunkIds,
            ]);

            console.log(
              `[RAG API] Successfully indexed ${esChunks.length} chunks in Elasticsearch`
            );
          })
          .catch((err) => {
            console.error("[RAG API] Error processing document:", (err as Error).message);
          });

        res.json({
          success: true,
          document_id: documentId,
          message: "Document uploaded and processing started",
        });
      } catch (error) {
        console.error("[RAG API] Error uploading document:", (error as Error).message);
        res.status(500).json({ error: (error as Error).message });
      }
    }
  );

  /**
   * GET /api/rag/documents
   * Get list of documents
   */
  router.get("/documents", async (req: Request, res: Response) => {
    try {
      const filters = {
        status: req.query.status as string,
        uploaded_by: req.query.uploaded_by as string,
        limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
      };

      const documents = await getDocuments(pool, filters);
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
  router.get("/documents/:id", async (req: Request, res: Response): Promise<any> => {
    try {
      const documentId = parseInt(req.params.id);

      // Get document info
      const docResult = await pool.query("SELECT * FROM documents WHERE id = $1", [documentId]);

      if (docResult.rows.length === 0) {
        return res.status(404).json({ error: "Document not found" });
      }

      const document = docResult.rows[0];

      // Get chunks
      const chunks = await getDocumentContext(pool, documentId, {
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
   * Delete a document
   */
  router.delete("/documents/:id", async (req: Request, res: Response) => {
    try {
      const documentId = parseInt(req.params.id);

      // Delete from Elasticsearch
      await deleteDocumentChunks(documentId);

      // Delete from database
      await deleteDocument(pool, documentId);

      res.json({
        success: true,
        message: "Document deleted successfully",
      });
    } catch (error) {
      console.error("[RAG API] Error deleting document:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // ===== RETRIEVAL ENDPOINTS =====

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
        results = await searchWithFilters(pool, query, {
          ...filters,
          topK: top_k || 5,
        });
      } else {
        results = await retrieveRelevantChunks(pool, query, {
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

      const chunks = await retrieveRelevantChunks(pool, query, {
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
