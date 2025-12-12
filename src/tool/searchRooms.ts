import { tool } from "@langchain/core/tools";
import axios from "axios";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * Tool 4: Search Rooms by Criteria
 * Searches for rooms based on various criteria like price, size, location, etc.
 */
export const searchRoomsTool = tool(
  async ({ criteria }: { criteria: string }): Promise<string> => {
    try {
      console.log(`[Tool: Room Search] Searching rooms with criteria: ${criteria}`);

      // Parse the criteria string into query parameters
      const params = parseCriteriaToParams(criteria);

      const response = await axios.get(`${process.env.BE_API_URL}/api/mcp/tools/property/search`, {
        headers: process.env.BE_API_KEY ? { "x-api-key": process.env.BE_API_KEY } : {},
        params,
        timeout: 10000,
      });

      const rooms = response.data;

      // Format rooms data for LLM
      return JSON.stringify(
        {
          total: rooms.length,
          rooms: rooms.map((room: any) => ({
            id: room.id,
            title: room.title,
            description: room.description,
            price: room.price,
            location: room.location,
            latitude: room.latitude,
            longitude: room.longitude,
            roomSize: room.roomSize,
            numBedrooms: room.numBedrooms,
            numBathrooms: room.numBathrooms,
            availableFrom: room.availableFrom,
            isRoomAvailable: room.isRoomAvailable,
            ownerId: room.ownerId,
            city: room.city,
            district: room.district,
            ward: room.ward,
            street: room.street,
            addressDetails: room.addressDetails,
            ownerName: room.ownerName,
            imageUrls: room.imageUrls,
          })),
        },
        null,
        2
      );
    } catch (error) {
      console.error("[Tool: Room Search] Error:", (error as Error).message);
      return `Error searching rooms: ${(error as Error).message}`;
    }
  },
  {
    name: "search_rooms",
    description:
      "Search for rooms/properties based on various criteria like price, room size, location (city, district, ward, street). Use this when user wants to find rooms matching specific requirements. Criteria should be specified as a string with field:operator:value format, separated by commas. Supported operators: : (equals), :> (greater than), :< (less than), ~ (contains). Supported fields: price, size, city, district, ward, street. Examples: 'price:<5000000,size:>20,city:Thành phố Đà Nẵng' or 'district:Quận Thanh Khê,price:>3000000'",
    schema: z.object({
      criteria: z
        .string()
        .describe(
          "Search criteria in format 'field:operator:value,field:operator:value,...' (e.g., 'price:<5000000,size:>20,city:Thành phố Đà Nẵng')"
        ),
    }) as any, // Avoid deep type instantiation
  }
);

/**
 * Parse criteria string into query parameters for the API
 * @param criteria - Criteria string like "price:<5000000,size:>20,city:Thành phố Đà Nẵng"
 * @returns Object with query parameters
 */
function parseCriteriaToParams(criteria: string): Record<string, string> {
  const params: Record<string, string> = {};

  // Split by comma and process each criterion
  const criterionList = criteria.split(",").map((c) => c.trim());

  // Build filter string
  const filterParts: string[] = [];
  let search = "";

  for (const criterion of criterionList) {
    if (criterion.includes(":")) {
      const [field, operator, value] = parseCriterion(criterion);
      if (field && operator && value) {
        filterParts.push(`${field}${operator}${value}`);
      }
    } else {
      // If no operator, treat as search term
      search = criterion;
    }
  }

  if (filterParts.length > 0) {
    params.filter = filterParts.join(",");
  }

  if (search) {
    params.search = search;
  }

  // Default pagination
  params.page = "0";
  params.size = "20";
  params.sort = "price";
  params.order = "ASC";

  return params;
}

/**
 * Parse a single criterion like "price:<5000000" into field, operator, value
 */
function parseCriterion(criterion: string): [string, string, string] {
  // Match patterns like field:operator:value or field:value (defaults to equals)
  const match = criterion.match(/^([^:<>~]+)(:>|:<|:|>|<|~)?(.+)$/);
  if (!match) return ["", "", ""];

  const field = match[1].trim();
  const operator = match[2] || ":"; // Default to equals if no operator
  const value = match[3].trim();

  // Map field names to API field names
  const fieldMapping: Record<string, string> = {
    size: "size", // maps to roomSize
    price: "price",
    city: "city",
    district: "district",
    ward: "ward",
    street: "street",
  };

  const apiField = fieldMapping[field] || field;

  return [apiField, operator, value];
}
