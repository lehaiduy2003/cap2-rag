/**
 * Document Processing Service
 * Handles document upload, text extraction, chunking, and embedding generation
 */

import fs from "fs-extra";
import path from "path";
import { Pool, QueryResult } from "pg";
import { DocumentMetadata, ChunkRecord } from "./types";

// Embedding service (will use transformers.js for local embeddings)
let embeddingPipeline: any = null;

/**
 * Initialize the embedding model
 */
export async function initializeEmbeddingModel(): Promise<any> {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  try {
    console.log("[DocumentService] Initializing embedding model...");
    const { pipeline } = await import("@xenova/transformers");

    // Using all-MiniLM-L6-v2 which produces 384-dim embeddings (faster)
    // For 768-dim, use 'sentence-transformers/all-mpnet-base-v2'
    embeddingPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");

    console.log("[DocumentService] Embedding model initialized successfully");
    return embeddingPipeline;
  } catch (error) {
    console.error(
      "[DocumentService] Error initializing embedding model:",
      (error as Error).message
    );
    throw error;
  }
}

/**
 * Generate embedding for text
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const model = await initializeEmbeddingModel();

  try {
    const output = await model(text, {
      pooling: "mean",
      normalize: true,
    });

    // Convert to array
    return Array.from(output.data);
  } catch (error) {
    console.error("[DocumentService] Error generating embedding:", (error as Error).message);
    throw error;
  }
}

/**
 * Chunk text into smaller pieces with overlap
 */
export function chunkText(text: string, chunkSize: number = 500, overlap: number = 50): string[] {
  const chunks: string[] = [];
  const words = text.split(/\s+/);

  let currentChunk: string[] = [];
  let currentSize = 0;

  for (let i = 0; i < words.length; i++) {
    currentChunk.push(words[i]);
    currentSize++;

    if (currentSize >= chunkSize || i === words.length - 1) {
      chunks.push(currentChunk.join(" "));

      // Create overlap for next chunk
      if (i < words.length - 1) {
        currentChunk = currentChunk.slice(-overlap);
        currentSize = currentChunk.length;
      }
    }
  }

  return chunks.filter((chunk) => chunk.trim().length > 0);
}

/**
 * Process a document: extract text, chunk, and generate embeddings
 */
export async function processDocument(
  pool: Pool,
  documentId: number,
  fullText: string,
  metadata: DocumentMetadata = {}
): Promise<ChunkRecord[]> {
  try {
    console.log(`[DocumentService] Processing document ${documentId}...`);

    // Update document status to processing
    await pool.query(
      "UPDATE documents SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      ["processing", documentId]
    );

    // Chunk the text
    const chunkSize = metadata.chunk_size || 500;
    const overlap = metadata.overlap || 50;
    const chunks = chunkText(fullText, chunkSize, overlap);

    console.log(`[DocumentService] Created ${chunks.length} chunks for document ${documentId}`);

    // Process each chunk
    const chunkRecords: ChunkRecord[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];

      // Generate embedding (will be stored in Elasticsearch)
      const embedding = await generateEmbedding(chunkText);

      // Store chunk metadata in database (no embedding)
      const result: QueryResult = await pool.query(
        `INSERT INTO document_chunks 
         (document_id, chunk_text, chunk_index, chunk_metadata, es_indexed)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [
          documentId,
          chunkText,
          i,
          JSON.stringify({ length: chunkText.length }),
          false, // Will be set to true after Elasticsearch indexing
        ]
      );

      chunkRecords.push({
        chunk_id: result.rows[0].id,
        document_id: documentId,
        chunk_text: chunkText,
        chunk_index: i,
        embedding: embedding, // For Elasticsearch indexing
      });

      if ((i + 1) % 10 === 0) {
        console.log(`[DocumentService] Processed ${i + 1}/${chunks.length} chunks`);
      }
    }

    // Update document status to completed
    await pool.query(
      "UPDATE documents SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      ["completed", documentId]
    );

    console.log(`[DocumentService] Successfully processed document ${documentId}`);
    return chunkRecords;
  } catch (error) {
    console.error(
      `[DocumentService] Error processing document ${documentId}:`,
      (error as Error).message
    );

    // Update document status to failed
    await pool.query(
      "UPDATE documents SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      ["failed", documentId]
    );

    throw error;
  }
}

/**
 * Extract text from different file types
 */
export async function extractTextFromFile(filePath: string, contentType: string): Promise<string> {
  try {
    // Handle plain text files
    if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
      return await fs.readFile(filePath, "utf-8");
    }

    // Handle PDF files
    if (contentType.includes("application/pdf") || filePath.endsWith(".pdf")) {
      const pdfParse = require("pdf-parse");
      const dataBuffer = await fs.readFile(filePath);
      const data = await pdfParse(dataBuffer);
      return data.text;
    }

    // Handle Word documents (.docx)
    if (
      contentType.includes("application/vnd.openxmlformats-officedocument.wordprocessingml.document") ||
      filePath.endsWith(".docx")
    ) {
      const mammoth = require("mammoth");
      const result = await mammoth.extractRawText({ path: filePath });
      return result.value;
    }

    // Handle older Word documents (.doc)
    if (contentType.includes("application/msword") || filePath.endsWith(".doc")) {
      // Note: .doc requires additional processing, could use textract or other libraries
      throw new Error("Legacy .doc format not yet supported. Please convert to .docx");
    }

    throw new Error(`Unsupported file type: ${contentType}`);
  } catch (error) {
    console.error("[DocumentService] Error extracting text:", (error as Error).message);
    throw error;
  }
}

interface FileData {
  originalname?: string;
  buffer?: Buffer;
  content?: Buffer | string;
  mimetype?: string;
  size?: number;
}

/**
 * Save uploaded file and create document record
 */
export async function saveDocument(
  pool: Pool,
  fileData: FileData,
  metadata: DocumentMetadata = {}
): Promise<{ documentId: number; filename: string; filePath: string }> {
  try {
    // Create uploads directory if it doesn't exist
    const uploadsDir = path.join(__dirname, "../uploads/documents");
    await fs.ensureDir(uploadsDir);

    // Generate unique filename
    const timestamp = Date.now();
    const originalName = fileData.originalname || "document.txt";
    const filename = `${timestamp}_${originalName}`;
    const filePath = path.join(uploadsDir, filename);

    // Save file
    const content = fileData.buffer || fileData.content;
    if (!content) {
      throw new Error("No file content provided");
    }
    await fs.writeFile(filePath, content);

    // Create document record
    const result: QueryResult = await pool.query(
      `INSERT INTO documents
       (title, filename, content_type, file_size, uploaded_by, owner_id, property_id, kb_scope, metadata, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        metadata.title || originalName,
        filename,
        fileData.mimetype || metadata.content_type || "text/plain",
        fileData.size || (Buffer.isBuffer(content) ? content.length : 0),
        metadata.uploaded_by || "system",
        metadata.owner_id || null,
        metadata.property_id || null,
        metadata.kb_scope || "property",
        JSON.stringify(metadata),
        "pending",
      ]
    );
    const documentId = result.rows[0].id;

    console.log(`[DocumentService] Saved document ${documentId}: ${filename}`);

    return {
      documentId,
      filename,
      filePath,
    };
  } catch (error) {
    console.error("[DocumentService] Error saving document:", (error as Error).message);
    throw error;
  }
}

/**
 * Delete a document and all its chunks
 */
export async function deleteDocument(pool: Pool, documentId: number): Promise<boolean> {
  try {
    // Get document info
    const docResult: QueryResult = await pool.query(
      "SELECT filename FROM documents WHERE id = $1",
      [documentId]
    );

    if (docResult.rows.length === 0) {
      throw new Error(`Document ${documentId} not found`);
    }

    // Delete file from filesystem
    const filename = docResult.rows[0].filename;
    const filePath = path.join(__dirname, "../uploads/documents", filename);

    if (await fs.pathExists(filePath)) {
      await fs.remove(filePath);
    }

    // Delete from database (chunks will be deleted via CASCADE)
    await pool.query("DELETE FROM documents WHERE id = $1", [documentId]);

    console.log(`[DocumentService] Deleted document ${documentId}`);
    return true;
  } catch (error) {
    console.error("[DocumentService] Error deleting document:", (error as Error).message);
    throw error;
  }
}

interface DocumentFilters {
  status?: string;
  uploaded_by?: string;
  limit?: number;
}

/**
 * Get document list with stats
 */
export async function getDocuments(pool: Pool, filters: DocumentFilters = {}): Promise<any[]> {
  try {
    let query = `
      SELECT 
        d.id,
        d.title,
        d.filename,
        d.content_type,
        d.file_size,
        d.upload_date,
        d.uploaded_by,
        d.status,
        d.created_at,
        COUNT(dc.id) as chunk_count
      FROM documents d
      LEFT JOIN document_chunks dc ON d.id = dc.document_id
    `;

    const conditions: string[] = [];
    const params: any[] = [];

    if (filters.status) {
      conditions.push(`d.status = $${params.length + 1}`);
      params.push(filters.status);
    }

    if (filters.uploaded_by) {
      conditions.push(`d.uploaded_by = $${params.length + 1}`);
      params.push(filters.uploaded_by);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += " GROUP BY d.id ORDER BY d.upload_date DESC";

    if (filters.limit) {
      query += ` LIMIT ${parseInt(filters.limit.toString())}`;
    }

    const result: QueryResult = await pool.query(query, params);
    return result.rows;
  } catch (error) {
    console.error("[DocumentService] Error getting documents:", (error as Error).message);
    throw error;
  }
}
