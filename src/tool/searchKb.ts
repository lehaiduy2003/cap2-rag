import { tool } from "@langchain/core/tools";
import { formatContextForLLM, retrieveRelevantChunks } from "../ragRetrieval";
import { z } from "zod";

export const searchKnowledgeBaseTool = tool(
  async ({
    query,
    property_id,
    owner_id,
  }: {
    query: string;
    property_id?: number;
    owner_id?: string;
  }): Promise<string> => {
    try {
      console.log(
        `[Tool: KB Search] Query: "${query}", Property: ${property_id}, Owner: ${owner_id}`
      );

      const chunks = await retrieveRelevantChunks(query, {
        topK: 5,
        searchType: "hybrid",
        minScore: 0.6,
        rerank: true,
        propertyId: property_id,
        ownerId: owner_id,
      });

      if (chunks.length === 0) {
        return "No relevant information found in the knowledge base for this query.";
      }

      return formatContextForLLM(chunks);
    } catch (error) {
      console.error("[Tool: KB Search] Error:", (error as Error).message);
      return `Error searching knowledge base: ${(error as Error).message}`;
    }
  },
  {
    name: "search_knowledge_base",
    description:
      "Search the property knowledge base for information about rules, regulations, pricing, amenities, or any property-specific details. Use this when the user asks about internal property information, house rules, rental terms, or documents uploaded by the property owner. Returns relevant information from uploaded documents.",
    schema: z.object({
      query: z.string().describe("The search query to find relevant information"),
      property_id: z.number().optional().describe("Property ID to filter results"),
      owner_id: z.string().optional().describe("Owner ID to filter results"),
    }) as any, // Avoid deep type instantiation
  }
);
