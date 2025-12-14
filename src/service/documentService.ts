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
 * Estimate token count (approximate: 1 token ≈ 4 characters for Vietnamese/English mix)
 */
function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Semantic section patterns for Vietnamese property documents
 */
interface SemanticSection {
  title: string;
  content: string;
  priority: number; // Higher priority = more important
}

/**
 * Detect semantic sections in document based on headers and structure
 */
function detectSemanticSections(text: string): SemanticSection[] {
  const sections: SemanticSection[] = [];

  // Common Vietnamese document section patterns
  const sectionPatterns = [
    // Basic information sections
    {
      regex:
        /(?:^|\n)(?:I\.|1\.|###?)\s*(Thông tin cơ bản|Thông tin chung|Giới thiệu)[\s\S]*?(?=(?:\n(?:II\.|2\.|###?)|\n#{1,3}\s|$))/gi,
      title: "Thông tin cơ bản",
      priority: 10,
    },
    {
      regex:
        /(?:^|\n)(?:Thông tin phòng trọ|Mô tả phòng)[:\s]*([^\n]+(?:\n(?!(?:II\.|2\.|###?|Giá|Địa chỉ|Hợp đồng|Quy định))[^\n]+)*)/gi,
      title: "Thông tin phòng trọ",
      priority: 10,
    },

    // Pricing sections
    {
      regex:
        /(?:^|\n)(?:II\.|2\.|###?)\s*(Giá thuê|Giá cả|Chi phí)[\s\S]*?(?=(?:\n(?:III\.|3\.|###?)|\n#{1,3}\s|$))/gi,
      title: "Thông tin giá thuê",
      priority: 9,
    },
    {
      regex:
        /(?:^|\n)(?:Giá thuê|Giá)[:\s]*([^\n]+(?:\n(?!(?:III\.|3\.|###?|Địa chỉ|Hợp đồng|Quy định))[^\n]+)*)/gi,
      title: "Thông tin giá thuê",
      priority: 9,
    },

    // Location/Address sections
    {
      regex:
        /(?:^|\n)(?:III\.|3\.|###?)\s*(Địa chỉ|Vị trí|Khu vực)[\s\S]*?(?=(?:\n(?:IV\.|4\.|###?)|\n#{1,3}\s|$))/gi,
      title: "Thông tin địa chỉ",
      priority: 9,
    },
    {
      regex:
        /(?:^|\n)(?:Địa chỉ)[:\s]*([^\n]+(?:\n(?!(?:IV\.|4\.|###?|Hợp đồng|Quy định))[^\n]+)*)/gi,
      title: "Thông tin địa chỉ",
      priority: 9,
    },

    // Contract sections
    {
      regex:
        /(?:^|\n)(?:IV\.|4\.|###?)\s*(Hợp đồng|Điều khoản hợp đồng|Thỏa thuận)[\s\S]*?(?=(?:\n(?:V\.|5\.|###?)|\n#{1,3}\s|$))/gi,
      title: "Thông tin hợp đồng",
      priority: 8,
    },
    {
      regex:
        /(?:^|\n)(?:Hợp đồng|Điều khoản)[:\s]*([^\n]+(?:\n(?!(?:V\.|5\.|###?|Quy định|Tiện ích))[^\n]+)*)/gi,
      title: "Thông tin hợp đồng",
      priority: 8,
    },

    // Rules and regulations
    {
      regex:
        /(?:^|\n)(?:V\.|5\.|###?)\s*(Quy định|Nội quy|Quy tắc|Lưu ý)[\s\S]*?(?=(?:\n(?:VI\.|6\.|###?)|\n#{1,3}\s|$))/gi,
      title: "Quy định và nội quy",
      priority: 7,
    },
    {
      regex:
        /(?:^|\n)(?:Quy định|Nội quy)[:\s]*([^\n]+(?:\n(?!(?:VI\.|6\.|###?|Tiện ích|Liên hệ))[^\n]+)*)/gi,
      title: "Quy định và nội quy",
      priority: 7,
    },

    // Amenities/Utilities
    {
      regex:
        /(?:^|\n)(?:VI\.|6\.|###?)\s*(Tiện ích|Tiện nghi|Cơ sở vật chất)[\s\S]*?(?=(?:\n(?:VII\.|7\.|###?)|\n#{1,3}\s|$))/gi,
      title: "Tiện ích và tiện nghi",
      priority: 6,
    },
    {
      regex:
        /(?:^|\n)(?:Tiện ích|Tiện nghi)[:\s]*([^\n]+(?:\n(?!(?:VII\.|7\.|###?|Liên hệ))[^\n]+)*)/gi,
      title: "Tiện ích và tiện nghi",
      priority: 6,
    },

    // Contact/Summary sections
    {
      regex:
        /(?:^|\n)(?:VII\.|7\.|###?)\s*(Liên hệ|Thông tin liên hệ|Tổng kết)[\s\S]*?(?=(?:\n(?:VIII\.|8\.|###?)|\n#{1,3}\s|$))/gi,
      title: "Thông tin liên hệ",
      priority: 5,
    },
    {
      regex:
        /(?:^|\n)(?:Tóm tắt|Kết luận|Tổng kết)[:\s]*([^\n]+(?:\n(?!(?:VIII\.|8\.|###?))[^\n]+)*)/gi,
      title: "Tóm tắt",
      priority: 5,
    },
  ];

  // Track matched positions to find unmatched content
  interface MatchedRange {
    start: number;
    end: number;
    content: string;
  }
  const matchedRanges: MatchedRange[] = [];

  for (const pattern of sectionPatterns) {
    const matches = text.matchAll(pattern.regex);
    for (const match of matches) {
      const content = match[0].trim();
      const startPos = text.indexOf(content);

      if (startPos === -1) continue;

      // Check for overlaps with existing ranges
      const isOverlapping = matchedRanges.some(
        (range) =>
          (startPos >= range.start && startPos < range.end) ||
          (startPos + content.length > range.start && startPos + content.length <= range.end) ||
          (startPos <= range.start && startPos + content.length >= range.end)
      );

      // Only add if content is substantial and not overlapping
      if (content.length > 50 && !isOverlapping) {
        matchedRanges.push({
          start: startPos,
          end: startPos + content.length,
          content: content,
        });
        sections.push({
          title: pattern.title,
          content: content,
          priority: pattern.priority,
        });
      }
    }
  }

  // Sort matched ranges by position to find gaps
  matchedRanges.sort((a, b) => a.start - b.start);

  // Find unmatched content (gaps between matched sections)
  const unmatchedSections: string[] = [];
  let lastEnd = 0;

  for (const range of matchedRanges) {
    if (range.start > lastEnd) {
      const unmatchedContent = text.substring(lastEnd, range.start).trim();
      if (unmatchedContent.length > 50) {
        unmatchedSections.push(unmatchedContent);
      }
    }
    lastEnd = Math.max(lastEnd, range.end);
  }

  // Check for content after the last matched section
  if (lastEnd < text.length) {
    const remainingContent = text.substring(lastEnd).trim();
    if (remainingContent.length > 50) {
      unmatchedSections.push(remainingContent);
    }
  }

  // Add unmatched sections as "Other/Description" sections with lower priority
  for (let i = 0; i < unmatchedSections.length; i++) {
    sections.push({
      title: unmatchedSections.length === 1 ? "Mô tả khác" : `Mô tả khác - Phần ${i + 1}`,
      content: unmatchedSections[i],
      priority: 3, // Lower priority than specific sections
    });
  }

  // Sort by priority (descending) and then by position in text
  sections.sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return text.indexOf(a.content) - text.indexOf(b.content);
  });

  console.log(
    `[Chunking] Detected ${sections.length} sections (${
      sections.filter((s) => s.priority === 3).length
    } unmatched)`
  );

  return sections;
}

/**
 * Chunk text by semantic sections with proper titles
 */
function chunkBySemantic(text: string, maxTokens: number = 400): string[] {
  const chunks: string[] = [];
  const sections = detectSemanticSections(text);

  if (sections.length === 0) {
    // If no sections detected at all, treat entire text as "Other description"
    console.log(`[Chunking] No semantic sections detected, chunking entire text as description`);
    const textTokens = estimateTokenCount(text);

    if (textTokens <= maxTokens) {
      chunks.push(`[Mô tả khác]\n${text}`);
    } else {
      const subsections = splitLongSection(text, "Mô tả khác", maxTokens);
      chunks.push(...subsections);
    }
    return chunks;
  }

  console.log(`[Chunking] Found ${sections.length} semantic sections`);

  for (const section of sections) {
    const sectionTokens = estimateTokenCount(section.content);

    // If section is small enough, create one chunk with title
    if (sectionTokens <= maxTokens) {
      const chunkWithTitle = `[${section.title}]\n${section.content}`;
      chunks.push(chunkWithTitle);
    } else {
      // Split large section into smaller chunks but keep the title
      const subsections = splitLongSection(section.content, section.title, maxTokens);
      chunks.push(...subsections);
    }
  }

  return chunks;
}

/**
 * Split a long section into smaller chunks while preserving context
 */
function splitLongSection(content: string, sectionTitle: string, maxTokens: number): string[] {
  const chunks: string[] = [];
  const paragraphs = content.split(/\n\n+/);

  let currentChunk = `[${sectionTitle}]\n`;
  let currentTokens = estimateTokenCount(currentChunk);

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i].trim();
    if (!paragraph) continue;

    const paragraphTokens = estimateTokenCount(paragraph);

    // If single paragraph exceeds max, split it further
    if (paragraphTokens > maxTokens) {
      // Save current chunk if it has content
      if (currentTokens > estimateTokenCount(`[${sectionTitle}]\n`)) {
        chunks.push(currentChunk.trim());
      }

      // Split long paragraph by sentences
      const sentences = paragraph.split(/[.!?。]+/).filter((s) => s.trim());
      let sentenceChunk = `[${sectionTitle} - Phần ${chunks.length + 1}]\n`;
      let sentenceTokens = estimateTokenCount(sentenceChunk);

      for (const sentence of sentences) {
        const sentenceWithPunct = sentence.trim() + ".";
        const tokens = estimateTokenCount(sentenceWithPunct);

        if (sentenceTokens + tokens > maxTokens && sentenceTokens > 0) {
          chunks.push(sentenceChunk.trim());
          sentenceChunk = `[${sectionTitle} - Phần ${chunks.length + 1}]\n${sentenceWithPunct}\n`;
          sentenceTokens = estimateTokenCount(sentenceChunk);
        } else {
          sentenceChunk += sentenceWithPunct + " ";
          sentenceTokens += tokens;
        }
      }

      if (sentenceTokens > 0) {
        chunks.push(sentenceChunk.trim());
      }

      // Reset for next paragraph
      currentChunk = `[${sectionTitle}]\n`;
      currentTokens = estimateTokenCount(currentChunk);
      continue;
    }

    // Check if adding this paragraph would exceed the limit
    if (
      currentTokens + paragraphTokens > maxTokens &&
      currentTokens > estimateTokenCount(`[${sectionTitle}]\n`)
    ) {
      chunks.push(currentChunk.trim());
      currentChunk = `[${sectionTitle} - Tiếp theo]\n${paragraph}\n\n`;
      currentTokens = estimateTokenCount(currentChunk);
    } else {
      currentChunk += paragraph + "\n\n";
      currentTokens += paragraphTokens;
    }
  }

  // Add remaining content
  if (currentTokens > estimateTokenCount(`[${sectionTitle}]\n`)) {
    chunks.push(currentChunk.trim());
  }

  return chunks;
}

/**
 * Smart chunking: Try semantic first, fallback to length-based
 */
export function chunkText(text: string, chunkSize: number = 400): string[] {
  console.log(
    `[Chunking] Processing text of ${text.length} characters (≈${estimateTokenCount(text)} tokens)`
  );

  if (!text || text.trim().length === 0) {
    console.log(`[Chunking] Empty text provided, returning empty array`);
    return [];
  }

  // Try semantic chunking first (will always return chunks now, never empty)
  const semanticChunks = chunkBySemantic(text, chunkSize);

  console.log(`[Chunking] Created ${semanticChunks.length} semantic chunks`);

  // Verify we captured all content by comparing total length
  const totalChunkLength = semanticChunks.reduce((sum, chunk) => {
    // Remove section headers like "[Mô tả khác]\n" to get actual content length
    const contentWithoutHeader = chunk.replace(/^\[.*?\]\n/, "");
    return sum + contentWithoutHeader.length;
  }, 0);

  const originalLength = text.length;
  const captureRate = (totalChunkLength / originalLength) * 100;

  console.log(
    `[Chunking] Content capture rate: ${captureRate.toFixed(
      1
    )}% (${totalChunkLength}/${originalLength} chars)`
  );

  if (captureRate < 90) {
    console.warn(`[Chunking] Low capture rate detected! Some content may be missing.`);
  }

  return semanticChunks;
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
    const chunks = chunkText(fullText, chunkSize);

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

    // Index in Elasticsearch - only chunk-specific and document-specific data
    // Property metadata (description, price, etc.) should be fetched from VAT service when needed
    const esChunks = chunkRecords.map((chunk) => ({
      chunk_id: chunk.chunk_id,
      document_id: chunk.document_id,
      title: title || "Untitled",
      chunk_text: chunk.chunk_text,
      chunk_index: chunk.chunk_index,
      owner_id: owner_id,
      property_id: property_id,
      embedding: chunk.embedding,
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
