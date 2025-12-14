/**
 * RAG Retrieval Service
 * Uses Elasticsearch for vector search and document retrieval
 */

import { generateEmbedding } from "./service/documentService";
import { vectorSearch, hybridSearch, textSearch } from "./elasticsearchClient";
import { RetrievalOptions, SearchResult } from "./types";

/**
 * Retrieve relevant chunks from Elasticsearch with property/owner filtering
 */
async function retrieveFromElasticsearch(
  query: string,
  queryEmbedding: number[] | null,
  options: RetrievalOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5, minScore = 0.7, searchType = "hybrid", ownerId, propertyId } = options;

  const filters = {
    owner_id: ownerId,
    property_id: propertyId,
  };

  try {
    let results: SearchResult[] = [];

    switch (searchType) {
      case "text":
        results = await textSearch(query, topK, filters);
        break;
      case "vector":
        if (!queryEmbedding) {
          queryEmbedding = await generateEmbedding(query);
        }
        results = await vectorSearch(queryEmbedding, topK, minScore, filters);
        break;
      case "hybrid":
        if (!queryEmbedding) {
          queryEmbedding = await generateEmbedding(query);
        }
        results = await hybridSearch(query, queryEmbedding, topK, filters);
        break;
      default:
        throw new Error(`Unknown search type: ${searchType}`);
    }

    return results.map((result) => ({
      ...result,
      title: result.title || "Untitled",
      source: "elasticsearch" as const,
    }));
  } catch (error) {
    console.error("[RAG Retrieval] Error retrieving from Elasticsearch:", (error as Error).message);
    throw error;
  }
}

/**
 * Retrieve relevant chunks using Elasticsearch only
 */
export async function retrieveRelevantChunks(
  query: string,
  options: RetrievalOptions = {}
): Promise<SearchResult[]> {
  const { topK = 5, minScore = 0.7, searchType = "hybrid", rerank = true } = options;

  try {
    console.log(`[RAG Retrieval] Retrieving chunks for query: "${query.substring(0, 100)}..."`);

    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(query);

    // Retrieve from Elasticsearch (primary source for vector search)
    const esResults = await retrieveFromElasticsearch(query, queryEmbedding, {
      topK: Math.ceil(topK * 1.5),
      minScore,
      searchType,
      ownerId: options.ownerId,
      propertyId: options.propertyId,
    });

    if (esResults.length === 0) {
      console.log("[RAG Retrieval] No results found in Elasticsearch");
      return [];
    }

    // Elasticsearch has all the data we need, no need to enrich from PostgreSQL
    const enrichedChunks = esResults;

    // Rerank if requested
    let finalChunks: SearchResult[] = enrichedChunks;
    if (rerank && enrichedChunks.length > topK) {
      finalChunks = rerankChunks(enrichedChunks, query);
    }

    // Return top K results
    const topChunks = finalChunks.slice(0, topK);

    console.log(`[RAG Retrieval] Retrieved ${topChunks.length} relevant chunks`);

    return topChunks;
  } catch (error) {
    console.error("[RAG Retrieval] Error in retrieval:", (error as Error).message);
    throw error;
  }
}

/**
 * Deduplicate chunks based on chunk_id
 */
export function deduplicateChunks(chunks: SearchResult[]): SearchResult[] {
  const seen = new Set<number>();
  const unique: SearchResult[] = [];

  for (const chunk of chunks) {
    if (!seen.has(chunk.chunk_id)) {
      seen.add(chunk.chunk_id);
      unique.push(chunk);
    }
  }

  // Sort by score (similarity_score or score)
  unique.sort((a, b) => {
    const scoreA = a.similarity_score || a.score || 0;
    const scoreB = b.similarity_score || b.score || 0;
    return scoreB - scoreA;
  });

  return unique;
}

/**
 * Simple reranking based on keyword matching and score
 */
export function rerankChunks(chunks: SearchResult[], query: string): SearchResult[] {
  const queryWords = query.toLowerCase().split(/\s+/);

  return chunks
    .map((chunk) => {
      let rerankScore = chunk.similarity_score || chunk.score || 0;

      // Boost score based on keyword matches
      const chunkText = chunk.chunk_text.toLowerCase();
      let keywordMatches = 0;

      for (const word of queryWords) {
        if (word.length > 3 && chunkText.includes(word)) {
          keywordMatches++;
        }
      }

      // Boost by 10% for each keyword match (up to 50%)
      const boost = Math.min(keywordMatches * 0.1, 0.5);
      rerankScore = rerankScore * (1 + boost);

      return {
        ...chunk,
        rerank_score: rerankScore,
      };
    })
    .sort((a, b) => (b.rerank_score || 0) - (a.rerank_score || 0));
}

/**
 * Format retrieved chunks into context for LLM
 */
export function formatContextForLLM(chunks: SearchResult[]): string {
  if (chunks.length === 0) {
    return "No relevant information found in the knowledge base.";
  }

  let context = "Relevant information from the knowledge base:\n\n";

  chunks.forEach((chunk, index) => {
    context += `[${index + 1}] From "${chunk.title}":\n`;
    context += `${chunk.chunk_text}\n\n`;
  });

  return context;
}

/**
 * Get document context for a specific document
 */
export async function getDocumentContext(
  _documentId: number,
  _options: { maxChunks?: number } = {}
): Promise<SearchResult[]> {
  try {
    // Not implemented - using Elasticsearch directly
    return [];
  } catch (error) {
    console.error("[RAG Retrieval] Error getting document context:", (error as Error).message);
    throw error;
  }
}

/**
 * Search with filters using Elasticsearch
 */
export async function searchWithFilters(
  query: string,
  filters: {
    documentIds?: number[];
    uploadedBy?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
    topK?: number;
    searchType?: "text" | "vector" | "hybrid";
  } = {}
): Promise<SearchResult[]> {
  const {
    documentIds = [],
    dateFrom = null,
    dateTo = null,
    topK = 5,
    searchType = "hybrid",
  } = filters;

  try {
    const axios = require("axios");
    const ES_HOST = process.env.ES_HOST || "http://localhost:9200";
    const ES_INDEX_NAME = process.env.ES_INDEX_NAME || "documents_chunks";

    // Generate embedding
    const queryEmbedding = await generateEmbedding(query);

    // Build Elasticsearch query with filters
    const must: any[] = [];
    const filter: any[] = [];

    if (documentIds.length > 0) {
      filter.push({ terms: { document_id: documentIds } });
    }

    if (dateFrom || dateTo) {
      const range: any = { created_at: {} };
      if (dateFrom) range.created_at.gte = dateFrom;
      if (dateTo) range.created_at.lte = dateTo;
      filter.push({ range });
    }

    // Add text search
    if (searchType === "text" || searchType === "hybrid") {
      must.push({
        multi_match: {
          query: query,
          fields: ["chunk_text^2", "document_title"],
          type: "best_fields",
          fuzziness: "AUTO",
        },
      });
    }

    const searchBody: any = {
      query: {
        bool: {
          must: must.length > 0 ? must : { match_all: {} },
          filter,
        },
      },
      size: topK,
      _source: ["document_id", "chunk_id", "document_title", "chunk_text", "chunk_index"],
    };

    // Add vector search if needed
    if (searchType === "vector" || searchType === "hybrid") {
      searchBody.knn = {
        field: "embedding",
        query_vector: queryEmbedding,
        k: topK,
        num_candidates: topK * 10,
        filter: filter.length > 0 ? filter : undefined,
      };
    }

    const response = await axios.post(`${ES_HOST}/${ES_INDEX_NAME}/_search`, searchBody);

    return response.data.hits.hits.map((hit: any) => ({
      ...hit._source,
      score: hit._score,
      source: "elasticsearch",
    }));
  } catch (error) {
    console.error("[RAG Retrieval] Error in filtered search:", (error as Error).message);
    throw error;
  }
}
