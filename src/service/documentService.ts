/**
 * Document Processing Service
 * Handles document upload, text extraction, chunking, and embedding generation
 * Uses Elasticsearch for storage - no PostgreSQL dependency
 */

import fs from "fs-extra";
import path from "path";
import { DocumentMetadata, ChunkRecord } from "../types";

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
 * Returns chunk records for Elasticsearch indexing (no database storage)
 */
export async function processDocument(
  documentId: number,
  fullText: string,
  metadata: DocumentMetadata = {}
): Promise<ChunkRecord[]> {
  try {
    console.log(`[DocumentService] Processing document ${documentId}...`);

    // Chunk the text
    const chunkSize = metadata.chunk_size || 500;
    const overlap = metadata.overlap || 50;
    const chunks = chunkText(fullText, chunkSize, overlap);

    console.log(`[DocumentService] Created ${chunks.length} chunks for document ${documentId}`);

    // Process each chunk
    const chunkRecords: ChunkRecord[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];

      // Generate embedding directly from chunk text
      // (metadata is already included in the text from enrichedFullText)
      const embedding = await generateEmbedding(chunkText);

      // Create chunk record (no database storage - only for Elasticsearch)
      // Use a hash of document_id and index as chunk_id
      const chunkId = parseInt(`${documentId}${i.toString().padStart(4, "0")}`);

      chunkRecords.push({
        chunk_id: chunkId,
        document_id: documentId,
        chunk_text: chunkText,
        chunk_index: i,
        embedding: embedding, // For Elasticsearch indexing
      });

      if ((i + 1) % 10 === 0) {
        console.log(`[DocumentService] Processed ${i + 1}/${chunks.length} chunks`);
      }
    }

    console.log(`[DocumentService] Successfully processed document ${documentId}`);
    return chunkRecords;
  } catch (error) {
    console.error(
      `[DocumentService] Error processing document ${documentId}:`,
      (error as Error).message
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
      contentType.includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ) ||
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
 * Save uploaded file (no database - only filesystem)
 * Document metadata is managed by VAT service
 */
export async function saveDocument(
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

    // Generate document ID from timestamp (no database storage)
    const documentId = metadata.document_id || timestamp;

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
 * Delete a document and all its chunks from Elasticsearch
 */
export async function deleteDocument(documentId: number): Promise<boolean> {
  const { deleteDocumentChunks } = require("../elasticsearchClient");

  try {
    // Delete from Elasticsearch
    await deleteDocumentChunks(documentId);

    // Delete files from filesystem (search for files with this document ID)
    const uploadsDir = path.join(__dirname, "../uploads/documents");
    const files = await fs.readdir(uploadsDir);

    for (const file of files) {
      if (file.includes(`${documentId}_`)) {
        const filePath = path.join(uploadsDir, file);
        if (await fs.pathExists(filePath)) {
          await fs.remove(filePath);
          console.log(`[DocumentService] Deleted file: ${file}`);
        }
      }
    }

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
 * Get document list from Elasticsearch
 * This function is deprecated - use VAT service for document management
 */
export async function getDocuments(_filters: DocumentFilters = {}): Promise<any[]> {
  try {
    // Documents are managed by VAT service, not stored in RAG service
    // This is a placeholder that returns empty array
    console.log("[DocumentService] getDocuments called - redirecting to VAT service");
    return [];
  } catch (error) {
    console.error("[DocumentService] Error getting documents:", (error as Error).message);
    throw error;
  }
}

/**
 * Process document from URL and update VAT service
 * No database storage - chunks are only indexed in Elasticsearch
 */
export async function processDocumentFromUrl(
  documentId: number,
  uploadUrl: string,
  vatServiceUrl: string,
  vatApiKey: string,
  metadata: DocumentMetadata = {}
): Promise<void> {
  const axios = require("axios");
  const { bulkIndexChunks } = require("../elasticsearchClient");

  try {
    console.log(`[DocumentService] Starting to process document ${documentId} from URL`);

    // Fetch document from URL
    console.log(`[DocumentService] Fetching document from ${uploadUrl}`);
    const fileResponse = await axios.get(uploadUrl, {
      responseType: "arraybuffer",
      timeout: 60000, // 60 seconds timeout
    });

    const fileBuffer = Buffer.from(fileResponse.data);

    // Determine content type
    const contentType =
      fileResponse.headers["content-type"] || metadata.content_type || "application/octet-stream";

    // Save file temporarily
    const uploadsDir = path.join(__dirname, "../uploads/documents");
    await fs.ensureDir(uploadsDir);

    const timestamp = Date.now();
    const filename = `${timestamp}_${metadata.original_filename || "document"}`;
    const filePath = path.join(uploadsDir, filename);

    await fs.writeFile(filePath, fileBuffer);
    console.log(`[DocumentService] Saved file temporarily at ${filePath}`);

    // Extract text from file
    const fullText = await extractTextFromFile(filePath, contentType);
    console.log(`[DocumentService] Extracted ${fullText.length} characters of text`);
    const {
      description,
      price,
      room_size,
      address_details,
      original_filename,
      owner_id,
      property_id,
      title,
    } = metadata;

    // Prepend property information to the document text for better RAG retrieval
    let enrichedFullText = fullText;
    const propertyInfoParts = [];

    if (description) {
      propertyInfoParts.push(`Thông tin phòng trọ: ${description}`);
    }
    if (price) {
      propertyInfoParts.push(`Giá thuê: ${price} VND/tháng`);
    }
    if (room_size) {
      propertyInfoParts.push(`Diện tích: ${room_size} m²`);
    }
    if (address_details) {
      propertyInfoParts.push(`Địa chỉ: ${address_details}`);
    }

    if (propertyInfoParts.length > 0) {
      enrichedFullText = propertyInfoParts.join("\n") + "\n\n" + fullText;
      console.log(`[DocumentService] Enriched document with property information`);
    }

    // Process document (chunk and embed)
    const docMetadata = {
      chunk_size: metadata.chunk_size || 500,
      overlap: metadata.overlap || 50,
      owner_id,
      property_id,
      // Include property metadata for embedding
      description,
      price,
      room_size,
      address_details,
      original_filename,
    };

    const chunkRecords = await processDocument(documentId, enrichedFullText, docMetadata);
    console.log(`[DocumentService] Created ${chunkRecords.length} chunks`);

    // Index in Elasticsearch with property metadata (no DB query needed - use passed metadata)
    const esChunks = chunkRecords.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      title: title || "Untitled",
      chunk_text: chunk.chunk_text,
      chunk_index: chunk.chunk_index,
      owner_id: owner_id,
      property_id: property_id,
      embedding: chunk.embedding,
      // Include property metadata for enhanced search
      description: description,
      price: price,
      room_size: room_size,
      address_details: address_details,
      created_at: new Date().toISOString(),
    }));

    await bulkIndexChunks(esChunks);
    console.log(`[DocumentService] Indexed ${esChunks.length} chunks in Elasticsearch`);

    // Update VAT service: mark as completed
    await axios.patch(
      `${vatServiceUrl}/api/v1/documents/${documentId}`,
      {
        status: "completed",
        processing_completed_at: new Date().toISOString(),
        chunk_count: chunkRecords.length,
        metadata: {
          ...metadata,
          rag_document_id: documentId,
          text_length: fullText.length,
          chunk_count: chunkRecords.length,
        },
      },
      {
        headers: {
          "x-api-key": vatApiKey,
        },
      }
    );

    console.log(
      `[DocumentService] Successfully processed document ${documentId}, created ${chunkRecords.length} chunks`
    );
  } catch (error) {
    console.error(
      `[DocumentService] Error processing document ${documentId}:`,
      (error as Error).message
    );

    // Update VAT service: mark as failed
    try {
      await axios.patch(
        `${vatServiceUrl}/api/v1/documents/${documentId}`,
        {
          status: "failed",
          processing_completed_at: new Date().toISOString(),
          error_message: (error as Error).message,
        },
        {
          headers: {
            "x-api-key": vatApiKey,
          },
        }
      );
    } catch (updateError) {
      console.error(
        `[DocumentService] Failed to update VAT service for document ${documentId}:`,
        (updateError as Error).message
      );
    }

    throw error;
  }
}
