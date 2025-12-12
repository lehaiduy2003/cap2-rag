import { tool } from "@langchain/core/tools";
import axios from "axios";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * Tool 2: Get Property Details from BE
 * Retrieves property information from the backend API
 */
export const getPropertyDetailsTool = tool(
  async ({ property_id }: { property_id: number }): Promise<string> => {
    try {
      console.log(`[Tool: Property API] Fetching room ${property_id}`);

      const response = await axios.get(
        `${process.env.BE_API_URL}/api/mcp/tools/property/${property_id}`,
        {
          headers: process.env.BE_API_KEY ? { "x-api-key": process.env.BE_API_KEY } : {},
          timeout: 10000,
        }
      );

      const property = response.data;

      // Format property data for LLM
      return JSON.stringify(
        {
          id: property.id,
          title: property.title,
          description: property.description,
          price: property.price,
          location: property.location,
          latitude: property.latitude,
          longitude: property.longitude,
          roomSize: property.roomSize,
          numBedrooms: property.numBedrooms,
          numBathrooms: property.numBathrooms,
          availableFrom: property.availableFrom,
          isRoomAvailable: property.isRoomAvailable,
          ownerId: property.ownerId,
          city: property.city,
          district: property.district,
          ward: property.ward,
          street: property.street,
          addressDetails: property.addressDetails,
          ownerName: property.ownerName,
          imageUrls: property.imageUrls,
        },
        null,
        2
      );
    } catch (error) {
      console.error("[Tool: Property API] Error:", (error as Error).message);
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return `Property with ID ${property_id} not found in the system.`;
      }
      return `Error fetching property details: ${(error as Error).message}`;
    }
  },
  {
    name: "get_property_details",
    description:
      "Get detailed information about a specific property/room from the backend system. Use this when user asks about property features, location, price, availability, images, or general property information. Returns structured property data including address details, room specifications, availability, owner information, etc.",
    schema: z.object({
      property_id: z.number().describe("The property ID to fetch details for"),
    }) as any, // Avoid deep type instantiation
  }
);
