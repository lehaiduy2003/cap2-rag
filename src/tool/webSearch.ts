import { tool } from "@langchain/core/tools";
import axios from "axios";
import * as cheerio from "cheerio";
import { z } from "zod";

/**
 * Tool 4: Web Search for Real-time Information
 * Searches the web for current information (government rates, news, etc.)
 */
export const webSearchTool = tool(
  async ({ query }: { query: string }): Promise<string> => {
    try {
      console.log(`[Tool: Web Search] Query: "${query}"`);

      // Use DuckDuckGo HTML search (doesn't require API key)
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      const response = await axios.get(searchUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
        },
        timeout: 15000,
      });

      const $ = cheerio.load(response.data);
      const results: string[] = [];

      // Extract search results
      $(".result__body").each((_i, elem) => {
        if (results.length >= 5) return; // Limit to 5 results

        const title = $(elem).find(".result__title").text().trim();
        const snippet = $(elem).find(".result__snippet").text().trim();

        if (title && snippet) {
          results.push(`**${title}**\n${snippet}`);
        }
      });

      if (results.length === 0) {
        return `No web search results found for query: "${query}". The information might not be publicly available or the query needs to be refined.`;
      }

      return `Web search results for "${query}":\n\n${results.join("\n\n---\n\n")}`;
    } catch (error) {
      console.error("[Tool: Web Search] Error:", (error as Error).message);
      return `Error performing web search: ${
        (error as Error).message
      }. Unable to fetch real-time information from the internet.`;
    }
  },
  {
    name: "web_search",
    description:
      "Search the web for real-time information that is not in the knowledge base or database. Use this for: government utility rates (electricity, water), current market prices, legal regulations, news, or any time-sensitive information that requires up-to-date data from the internet. Only use when the information is not available from other tools.",
    schema: z.object({
      query: z.string().describe("The search query for finding real-time information on the web"),
    }) as any, // Avoid deep type instantiation
  }
);
