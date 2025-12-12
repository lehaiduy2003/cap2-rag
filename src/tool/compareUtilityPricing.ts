import { tool } from "@langchain/core/tools";
import axios from "axios";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * Tool: Compare Utility Pricing
 * Compares utility pricing (electricity, water, internet, etc.) between properties
 * Fetches data from multiple rooms to provide comparative analysis
 */
export const compareUtilityPricingTool = tool(
  async ({
    current_property_id,
    max_results = 10,
  }: {
    current_property_id?: number;
    max_results?: number;
  }): Promise<string> => {
    try {
      console.log(
        `[Tool: Compare Utilities] Comparing utilities for room ${current_property_id} with other rooms`
      );

      // Get current property details if provided
      let currentProperty = null;
      if (current_property_id) {
        try {
          const currentResponse = await axios.get(
            `${process.env.BE_API_URL}/api/mcp/tools/property/${current_property_id}`,
            {
              headers: process.env.BE_API_KEY ? { "x-api-key": process.env.BE_API_KEY } : {},
              timeout: 10000,
            }
          );
          currentProperty = currentResponse.data;
        } catch (error) {
          console.error("[Tool: Compare Utilities] Error fetching current property:", error);
        }
      }

      // Search for other properties to compare
      // Get properties in the same area if we have location info
      let searchParams: any = {
        page: 0,
        size: max_results,
        sort: "price",
        order: "asc",
      };

      // If current property has location, search in same district
      if (currentProperty?.district) {
        searchParams.filter = `district:${currentProperty.district}`;
      }

      const response = await axios.get(`${process.env.BE_API_URL}/api/mcp/tools/property/search`, {
        headers: process.env.BE_API_KEY ? { "x-api-key": process.env.BE_API_KEY } : {},
        params: searchParams,
        timeout: 10000,
      });

      const properties = response.data;

      // Calculate statistics for comparison
      const prices = properties
        .map((p: any) => parseFloat(p.price || 0))
        .filter((p: number) => p > 0);
      const sizes = properties
        .map((p: any) => parseFloat(p.roomSize || 0))
        .filter((s: number) => s > 0);

      const stats = {
        totalProperties: properties.length,
        priceRange: {
          min: prices.length > 0 ? Math.min(...prices) : 0,
          max: prices.length > 0 ? Math.max(...prices) : 0,
          average:
            prices.length > 0
              ? prices.reduce((a: number, b: number) => a + b, 0) / prices.length
              : 0,
          median: prices.length > 0 ? calculateMedian(prices) : 0,
        },
        sizeRange: {
          min: sizes.length > 0 ? Math.min(...sizes) : 0,
          max: sizes.length > 0 ? Math.max(...sizes) : 0,
          average:
            sizes.length > 0 ? sizes.reduce((a: number, b: number) => a + b, 0) / sizes.length : 0,
        },
        pricePerSqm:
          prices.length > 0 && sizes.length > 0
            ? prices
                .map((p: number, i: number) => (sizes[i] > 0 ? p / sizes[i] : 0))
                .filter((p: number) => p > 0)
            : [],
      };

      const avgPricePerSqm =
        stats.pricePerSqm.length > 0
          ? stats.pricePerSqm.reduce((a: number, b: number) => a + b, 0) / stats.pricePerSqm.length
          : 0;

      // Format current property comparison if available
      let currentPropertyComparison = "";
      if (currentProperty) {
        const currentPricePerSqm =
          currentProperty.price && currentProperty.roomSize
            ? currentProperty.price / currentProperty.roomSize
            : 0;

        currentPropertyComparison = `
**Current Property Comparison:**
- Property ID: ${currentProperty.id}
- Title: ${currentProperty.title}
- Price: ${formatCurrency(currentProperty.price)}
- Size: ${currentProperty.roomSize} m²
- Price per m²: ${formatCurrency(currentPricePerSqm)}
- Location: ${currentProperty.district}, ${currentProperty.city}

**Compared to Similar Properties:**
- ${
          currentProperty.price > stats.priceRange.average ? "ABOVE" : "BELOW"
        } average price (Avg: ${formatCurrency(stats.priceRange.average)})
- ${
          currentPricePerSqm > avgPricePerSqm ? "ABOVE" : "BELOW"
        } average price per m² (Avg: ${formatCurrency(avgPricePerSqm)}/m²)
- Price percentile: ${calculatePercentile(prices, currentProperty.price)}%
`;
      }

      // Format sample properties for reference
      const sampleProperties = properties.slice(0, 5).map((p: any) => {
        const pricePerSqm = p.price && p.roomSize ? p.price / p.roomSize : 0;
        return {
          id: p.id,
          title: p.title,
          price: p.price,
          size: p.roomSize,
          pricePerSqm,
          location: `${p.district}, ${p.city}`,
          available: p.isRoomAvailable,
        };
      });

      return JSON.stringify(
        {
          searchArea: currentProperty?.district
            ? `${currentProperty.district}, ${currentProperty.city}`
            : "All areas",
          marketStatistics: {
            totalProperties: stats.totalProperties,
            priceRange: {
              min: formatCurrency(stats.priceRange.min),
              max: formatCurrency(stats.priceRange.max),
              average: formatCurrency(stats.priceRange.average),
              median: formatCurrency(stats.priceRange.median),
            },
            sizeRange: {
              min: `${stats.sizeRange.min.toFixed(1)} m²`,
              max: `${stats.sizeRange.max.toFixed(1)} m²`,
              average: `${stats.sizeRange.average.toFixed(1)} m²`,
            },
            averagePricePerSqm: formatCurrency(avgPricePerSqm) + "/m²",
          },
          currentPropertyAnalysis: currentProperty
            ? currentPropertyComparison
            : "No current property specified",
          sampleProperties,
          note: "These statistics are for room rent prices only. Utility costs (electricity, water, internet) are typically charged separately and may vary by landlord. To get accurate utility pricing comparison, you should also search for current government rates and compare with what other landlords charge.",
        },
        null,
        2
      );
    } catch (error) {
      console.error("[Tool: Compare Utilities] Error:", (error as Error).message);
      return `Error comparing utility pricing: ${(error as Error).message}`;
    }
  },
  {
    name: "compare_utility_pricing",
    description:
      "Compare property pricing and market data across multiple properties. Use this when user asks comparative questions like 'Is this cheaper than other rentals?', 'How does this compare to other rooms?', 'Is this a good deal?'. Provides market statistics (average, min, max prices), price per square meter comparison, and percentile ranking. Can focus on specific area if current_property_id is provided. Use together with web_search tool for complete utility comparison (electricity, water rates). For distance comparisons between properties, use the calculate_distance tool separately.",
    schema: z.object({
      current_property_id: z
        .number()
        .optional()
        .describe("The property ID to compare against others (optional)"),
      max_results: z
        .number()
        .optional()
        .default(10)
        .describe("Maximum number of properties to include in comparison (default: 10)"),
    }) as any,
  }
);

/**
 * Helper function to format currency in VND
 */
function formatCurrency(amount: number): string {
  if (!amount) return "0 VND";
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Calculate median of an array of numbers
 */
function calculateMedian(numbers: number[]): number {
  if (numbers.length === 0) return 0;
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Calculate percentile ranking
 */
function calculatePercentile(values: number[], target: number): number {
  if (values.length === 0) return 50;
  const belowOrEqual = values.filter((v) => v <= target).length;
  return Math.round((belowOrEqual / values.length) * 100);
}
