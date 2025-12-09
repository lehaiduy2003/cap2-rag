/**
 * Elasticsearch Configuration and Setup for RAG System
 */

import axios, { AxiosError } from "axios";

const ES_HOST = process.env.ES_HOST || "http://localhost:9200";
const ES_INDEX_NAME = process.env.ES_INDEX_NAME || "documents_chunks";
const ES_API_KEY = process.env.ES_API_KEY || "secret_api_key";

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

interface ESChunk {
  chunk_id: number;
  document_id: number;
  document_title?: string;
  chunk_text: string;
  chunk_index: number;
  embedding: number[];
  owner_id?: string;
  property_id?: number;
  metadata?: Record<string, any>;
  created_at: string;
}

export interface ESSearchResult {
  chunk_id: number;
  document_id: number;
  document_title: string;
  chunk_text: string;
  chunk_index: number;
  owner_id?: string;
  property_id?: number;
  score: number;
  similarity_score?: number;
  source: string;
}

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
          document_title: {
            type: "text",
            analyzer: "custom_text_analyzer",
            fields: { keyword: { type: "keyword" } },
          },
          chunk_text: {
            type: "text",
            analyzer: "custom_text_analyzer",
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
          metadata: { type: "object", enabled: true },
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
          fields: ["chunk_text^2", "document_title"],
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
        "document_title",
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
        "document_title",
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
                fields: ["chunk_text^2", "document_title"],
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
        "document_title",
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
 */
export async function deleteDocumentChunks(documentId: number): Promise<any> {
  try {
    const deleteBody = {
      query: { term: { document_id: documentId } },
    };

    const response = await esClient.post(`/${ES_INDEX_NAME}/_delete_by_query`, deleteBody);

    console.log(
      `[Elasticsearch] Deleted ${response.data.deleted} chunks for document ${documentId}`
    );
    return response.data;
  } catch (error) {
    const err = error as AxiosError;
    console.error("[Elasticsearch] Error deleting chunks:", err.response?.data || err.message);
    throw error;
  }
}

/**
 * Check Elasticsearch health
 */
export async function checkHealth(): Promise<any> {
  try {
    const response = await esClient.get(`/_cluster/health`);
    return response.data;
  } catch (error) {
    console.error("[Elasticsearch] Health check failed:", error);
    return null;
  }
}

export { ES_HOST, ES_INDEX_NAME };
