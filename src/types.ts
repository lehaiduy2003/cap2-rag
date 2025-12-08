/**
 * Type definitions for RAG Service
 */

export interface DocumentMetadata {
  title?: string;
  uploaded_by?: string;
  chunk_size?: number;
  overlap?: number;
  [key: string]: any;
}

export interface Document {
  id: number;
  title: string;
  filename: string;
  content_type: string;
  file_size: number;
  upload_date: Date;
  uploaded_by: string;
  owner_id?: string;
  property_id?: number;
  kb_scope?: "property" | "owner" | "global";
  metadata: Record<string, any>;
  status: "pending" | "processing" | "completed" | "failed";
  created_at: Date;
  updated_at: Date;
}

export interface DocumentChunk {
  id?: number;
  chunk_id?: number;
  document_id: number;
  document_title?: string;
  chunk_text: string;
  chunk_index?: number;
  chunk_metadata?: Record<string, any>;
  es_indexed?: boolean;
  owner_id?: string;
  property_id?: number;
  created_at?: Date;
  similarity_score?: number;
  score?: number;
  source?: string;
}

export interface ChunkRecord {
  chunk_id: number;
  document_id: number;
  chunk_text: string;
  chunk_index: number;
  embedding: number[];
}

export interface RetrievalOptions {
  topK?: number;
  minScore?: number;
  searchType?: "text" | "vector" | "hybrid";
  rerank?: boolean;
  ownerId?: string;
  propertyId?: number;
  kbScope?: "property" | "owner" | "global";
}

export interface SearchResult {
  chunk_id: number;
  document_id: number;
  document_title: string;
  chunk_text: string;
  chunk_index?: number;
  owner_id?: string;
  property_id?: number;
  score?: number;
  similarity_score?: number;
  rerank_score?: number;
  source: string;
}
