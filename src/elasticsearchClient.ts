/**
 * Elasticsearch Configuration and Setup for RAG System
 */

import axios, { AxiosError } from "axios";
import dotenv from "dotenv";
import { ESChunk, ESSearchResult } from "./types";

dotenv.config();

const ES_HOST = process.env.ES_HOST;
const ES_INDEX_NAME = process.env.ES_INDEX_NAME;
const ES_API_KEY = process.env.ES_API_KEY;

const esClient = axios.create({
  baseURL: ES_HOST,
  headers: ES_API_KEY
    ? {
        Authorization: `ApiKey ${ES_API_KEY}`,
        "Content-Type": "application/json",
      }
    : {
        "Content-Type": "application/json",
      },
});

/**
 * Create Elasticsearch index with proper mappings for document chunks
 */
export async function createElasticsearchIndex(): Promise<boolean> {
  try {
    // Check if index already exists
    const checkResponse = await esClient.head(`/${ES_INDEX_NAME}`, {
      validateStatus: () => true,
    });

    if (checkResponse.status === 200) {
      console.log(`[Elasticsearch] Index '${ES_INDEX_NAME}' already exists`);
      return true;
    }

    // Create index with mappings
    const mappings = {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: {
          analyzer: {
            custom_text_analyzer: {
              type: "custom",
              tokenizer: "standard",
              filter: ["lowercase", "asciifolding", "stop"],
            },
          },
        },
      },
      mappings: {
        properties: {
          document_id: { type: "integer" },
          chunk_id: { type: "integer" },
          title: {
            type: "text",
            analyzer: "custom_text_analyzer",
            fields: { keyword: { type: "keyword", ignore_above: 256 } },
          },
          chunk_text: {
            type: "text",
            analyzer: "custom_text_analyzer",
            // No keyword subfield to avoid ignore_above issues with long chunks
          },
          chunk_index: { type: "integer" },
          owner_id: {
            type: "keyword",
          },
          property_id: {
            type: "integer",
          },
          embedding: {
            type: "dense_vector",
            dims: 384,
            index: true,
            similarity: "cosine",
          },
          created_at: { type: "date" },
        },
      },
    };

    await esClient.put(`/${ES_INDEX_NAME}`, mappings);
    console.log(`[Elasticsearch] Successfully created index '${ES_INDEX_NAME}'`);
    return true;
  } catch (error) {
    const err = error as AxiosError;
    console.error("[Elasticsearch] Error creating index:", err.response?.data || err.message);
    throw error;
  }
}

/**
 * Index a document chunk in Elasticsearch
 */
export async function indexChunk(chunkData: ESChunk): Promise<any> {
  try {
    const response = await esClient.post(`/${ES_INDEX_NAME}/_doc/${chunkData.chunk_id}`, chunkData);
    return response.data;
  } catch (error) {
    const err = error as AxiosError;
    console.error("[Elasticsearch] Error indexing chunk:", err.response?.data || err.message);
    throw error;
  }
}

/**
 * Bulk index multiple document chunks
 */
export async function bulkIndexChunks(chunks: ESChunk[]): Promise<any> {
  try {
    const bulkBody: any[] = [];

    for (const chunk of chunks) {
      bulkBody.push({ index: { _index: ES_INDEX_NAME, _id: chunk.chunk_id } });
      bulkBody.push(chunk);
    }

    const response = await esClient.post(
      `/_bulk`,
      bulkBody.map((item) => JSON.stringify(item)).join("\n") + "\n",
      { headers: { "Content-Type": "application/x-ndjson" } }
    );

    if (response.data.errors) {
      console.error("[Elasticsearch] Bulk indexing had errors:", response.data.items);
    }

    return response.data;
  } catch (error) {
    const err = error as AxiosError;
    console.error("[Elasticsearch] Error bulk indexing:", err.response?.data || err.message);
    throw error;
  }
}

/**
 * Search for similar chunks using text search with optional filters
 */
export async function textSearch(
  query: string,
  size: number = 5,
  filters?: { owner_id?: string; property_id?: number }
): Promise<ESSearchResult[]> {
  try {
    const must: any[] = [
      {
        multi_match: {
          query: query,
          fields: ["chunk_text^2", "title"],
          type: "best_fields",
          fuzziness: "AUTO",
        },
      },
    ];

    const filter: any[] = [];
    if (filters?.owner_id) {
      filter.push({ term: { owner_id: filters.owner_id } });
    }
    if (filters?.property_id) {
      filter.push({ term: { property_id: filters.property_id } });
    }

    const searchBody = {
      query: {
        bool: {
          must,
          filter: filter.length > 0 ? filter : undefined,
        },
      },
      size: size,
      _source: [
        "document_id",
        "chunk_id",
        "title",
        "chunk_text",
        "chunk_index",
        "owner_id",
        "property_id",
      ],
    };

    const response = await esClient.post(`/${ES_INDEX_NAME}/_search`, searchBody);

    return response.data.hits.hits.map((hit: any) => ({
      ...hit._source,
      score: hit._score,
      source: "elasticsearch",
    }));
  } catch (error) {
    const err = error as AxiosError;
    console.error("[Elasticsearch] Error in text search:", err.response?.data || err.message);
    throw error;
  }
}

/**
 * Vector similarity search using kNN with optional filters
 */
export async function vectorSearch(
  queryEmbedding: number[],
  size: number = 5,
  minScore: number = 0.7,
  filters?: { owner_id?: string; property_id?: number }
): Promise<ESSearchResult[]> {
  try {
    const filter: any[] = [];
    if (filters?.owner_id) {
      filter.push({ term: { owner_id: filters.owner_id } });
    }
    if (filters?.property_id) {
      filter.push({ term: { property_id: filters.property_id } });
    }

    const searchBody = {
      knn: {
        field: "embedding",
        query_vector: queryEmbedding,
        k: size,
        num_candidates: size * 10,
        filter: filter.length > 0 ? filter : undefined,
      },
      min_score: minScore,
      _source: [
        "document_id",
        "chunk_id",
        "title",
        "chunk_text",
        "chunk_index",
        "owner_id",
        "property_id",
      ],
    };

    const response = await esClient.post(`/${ES_INDEX_NAME}/_search`, searchBody);

    return response.data.hits.hits.map((hit: any) => ({
      ...hit._source,
      score: hit._score,
      source: "elasticsearch",
    }));
  } catch (error) {
    const err = error as AxiosError;
    console.error("[Elasticsearch] Error in vector search:", err.response?.data || err.message);
    throw error;
  }
}

/**
 * Hybrid search combining text and vector search with optional filters
 */
export async function hybridSearch(
  query: string,
  queryEmbedding: number[],
  size: number = 5,
  filters?: { owner_id?: string; property_id?: number }
): Promise<ESSearchResult[]> {
  try {
    const filter: any[] = [];
    if (filters?.owner_id) {
      filter.push({ term: { owner_id: filters.owner_id } });
    }
    if (filters?.property_id) {
      filter.push({ term: { property_id: filters.property_id } });
    }

    const searchBody = {
      query: {
        bool: {
          should: [
            {
              multi_match: {
                query: query,
                fields: ["chunk_text^2", "title"],
                type: "best_fields",
                fuzziness: "AUTO",
              },
            },
          ],
          filter: filter.length > 0 ? filter : undefined,
        },
      },
      knn: {
        field: "embedding",
        query_vector: queryEmbedding,
        k: size,
        num_candidates: size * 10,
        filter: filter.length > 0 ? filter : undefined,
      },
      size: size,
      _source: [
        "document_id",
        "chunk_id",
        "title",
        "chunk_text",
        "chunk_index",
        "owner_id",
        "property_id",
      ],
    };

    const response = await esClient.post(`/${ES_INDEX_NAME}/_search`, searchBody);

    return response.data.hits.hits.map((hit: any) => ({
      ...hit._source,
      score: hit._score,
      source: "elasticsearch",
    }));
  } catch (error) {
    const err = error as AxiosError;
    console.error("[Elasticsearch] Error in hybrid search:", err.response?.data || err.message);
    throw error;
  }
}

/**
 * Delete document chunks from Elasticsearch
 * Removes all chunks associated with a document_id using delete_by_query
 * Works with semantic chunking - deletes ALL chunks regardless of count
 */
export async function deleteDocumentChunks(documentId: number): Promise<any> {
  try {
    console.log(`[Elasticsearch] Deleting all chunks for document ${documentId}...`);

    const deleteBody = {
      query: {
        term: { document_id: documentId },
      },
    };

    // Use refresh=true to make deletions immediately visible
    const response = await esClient.post(
      `/${ES_INDEX_NAME}/_delete_by_query?refresh=true&conflicts=proceed`,
      deleteBody
    );

    const deletedCount = response.data.deleted || 0;
    const failures = response.data.failures || [];

    if (failures.length > 0) {
      console.warn(
        `[Elasticsearch] Deleted ${deletedCount} chunks for document ${documentId}, but encountered ${failures.length} failures:`,
        failures
      );
    } else {
      console.log(
        `[Elasticsearch] Successfully deleted ${deletedCount} chunk(s) for document ${documentId}`
      );
    }

    return {
      deleted: deletedCount,
      failures: failures,
      took: response.data.took,
      timed_out: response.data.timed_out,
    };
  } catch (error) {
    const err = error as AxiosError;
    console.error(
      `[Elasticsearch] Error deleting chunks for document ${documentId}:`,
      err.response?.data || err.message
    );
    throw error;
  }
}

/**
 * Check Elasticsearch health
 */
export async function checkHealth(): Promise<any> {
  try {
    // Use root endpoint for health check as _cluster/health may not work with API keys
    const response = await esClient.get(`/`);
    return response.data;
  } catch (error) {
    console.error("[Elasticsearch] Health check failed:", error);
    return null;
  }
}

export { ES_HOST, ES_INDEX_NAME };
