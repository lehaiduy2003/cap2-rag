import { tool } from "@langchain/core/tools";
import axios from "axios";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * Tool 5: Search Nearby Rooms
 * Searches for rooms near a specific address/location
 */
export const searchNearbyRoomsTool = tool(
  async ({
    address,
    radius,
    city,
  }: {
    address: string;
    radius?: number;
    city?: string;
  }): Promise<string> => {
    try {
      // Enhance address with city context if provided
      let searchAddress = address;
      if (city && !address.toLowerCase().includes(city.toLowerCase())) {
        searchAddress = `${address}, ${city}`;
        console.log(`[Tool: Nearby Rooms] Enhanced address: "${address}" -> "${searchAddress}"`);
      }

      console.log(
        `[Tool: Nearby Rooms] Searching rooms near ${searchAddress} within ${radius || 500}m`
      );

      const params = new URLSearchParams();
      params.append("address", searchAddress);
      if (radius) {
        params.append("radius", radius.toString());
      }

      const response = await axios.get(
        `${process.env.BE_API_URL}/api/mcp/tools/property/nearby?${params}`,
        {
          headers: process.env.BE_API_KEY ? { "x-api-key": process.env.BE_API_KEY } : {}, 
          timeout: 10000,
        }
      );

      const rooms = response.data;

      // Format rooms data for LLM
      return JSON.stringify(
        {
          address: address,
          radius: radius || 500,
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
      console.error("[Tool: Nearby Rooms] Error:", (error as Error).message);
      return `Error searching nearby rooms for address "${address}": ${(error as Error).message}`;
    }
  },
  {
    name: "search_nearby_rooms",
    description:
      "Search for rooms/properties near a specific address or location. Use this when user asks about rooms near a particular place, street, or area. Can specify search radius in meters and city context for better accuracy. If city is provided, it will be automatically appended to the address for more precise geocoding.",
    schema: z.object({
      address: z
        .string()
        .describe(
          "The address or location to search around (e.g., 'Tôn Đản', '318 Tôn Đản', 'Phường Hòa Cường Bắc')"
        ),
      radius: z.number().optional().describe("Search radius in meters (default: 500)"),
      city: z
        .string()
        .optional()
        .describe(
          "City context to append to address for better geocoding (e.g., 'Đà Nẵng', 'Thành phố Hồ Chí Minh')"
        ),
    }) as any, // Avoid deep type instantiation
  }
);
