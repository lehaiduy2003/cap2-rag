import { tool } from "@langchain/core/tools";
import axios from "axios";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * Tool: Calculate Distance Between Properties or Addresses
 * Calculates the distance between two locations (properties or addresses)
 */
export const calculateDistanceTool = tool(
  async ({
    from_property_id,
    to_property_id,
    from_address,
    to_address,
  }: {
    from_property_id?: number;
    to_property_id?: number;
    from_address?: string;
    to_address?: string;
  }): Promise<string> => {
    try {
      console.log(
        `[Tool: Distance] Calculating distance from ${from_property_id || from_address} to ${
          to_property_id || to_address
        }`
      );

      // Validate inputs
      if (!from_property_id && !from_address && !to_property_id && !to_address) {
        return "Error: Must provide at least source and destination (either property IDs or addresses)";
      }

      if (!from_property_id && !from_address) {
        return "Error: Must provide source location (from_property_id or from_address)";
      }

      if (!to_property_id && !to_address) {
        return "Error: Must provide destination location (to_property_id or to_address)";
      }

      // Build query parameters
      const params: any = {};
      if (from_property_id) params.fromPropertyId = from_property_id;
      if (to_property_id) params.toPropertyId = to_property_id;
      if (from_address) params.fromAddress = from_address;
      if (to_address) params.toAddress = to_address;

      const response = await axios.get(`${process.env.BE_API_URL}/api/mcp/tools/distance`, {
        headers: process.env.BE_API_KEY ? { "x-api-key": process.env.BE_API_KEY } : {},
        params,
        timeout: 10000,
      });

      const result = response.data;

      // Format the response
      const sourceInfo = from_property_id
        ? `Property ID ${from_property_id}`
        : `Address: ${from_address}`;
      const destInfo = to_property_id ? `Property ID ${to_property_id}` : `Address: ${to_address}`;

      return JSON.stringify(
        {
          source: sourceInfo,
          destination: destInfo,
          distance: {
            kilometers: result.distanceKm,
            meters: result.distanceMeters,
            formatted: `${result.distanceKm} km (${result.distanceMeters} meters)`,
          },
          coordinates: {
            from: {
              latitude: result.fromCoordinates[0],
              longitude: result.fromCoordinates[1],
            },
            to: {
              latitude: result.toCoordinates[0],
              longitude: result.toCoordinates[1],
            },
          },
        },
        null,
        2
      );
    } catch (error) {
      console.error("[Tool: Distance] Error:", (error as Error).message);
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 400) {
          return `Error calculating distance: ${error.response.data}`;
        }
      }
      return `Error calculating distance: ${(error as Error).message}`;
    }
  },
  {
    name: "calculate_distance",
    description:
      "Calculate the straight-line distance between two properties or addresses. Use this when user asks about distance, proximity, or 'how far' between locations. You can provide property IDs, addresses, or both. Returns distance in kilometers and meters, along with coordinates. Useful for comparing property locations or answering location-based questions.",
    schema: z.object({
      from_property_id: z
        .number()
        .optional()
        .describe("Source property ID (optional if from_address provided)"),
      to_property_id: z
        .number()
        .optional()
        .describe("Destination property ID (optional if to_address provided)"),
      from_address: z
        .string()
        .optional()
        .describe("Source address (optional if from_property_id provided)"),
      to_address: z
        .string()
        .optional()
        .describe("Destination address (optional if to_property_id provided)"),
    }) as any,
  }
);
