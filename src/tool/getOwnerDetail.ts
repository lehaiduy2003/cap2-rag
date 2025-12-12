import { tool } from "@langchain/core/tools";
import axios from "axios";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

/**
 * Tool 3: Get Owner Information from BE
 * Retrieves owner/landlord information from the backend API
 */
export const getOwnerDetailsTool = tool(
  async ({ owner_id }: { owner_id: string }): Promise<string> => {
    try {
      console.log(`[Tool: Owner API] Fetching owner ${owner_id}`);

      const response = await axios.get(
        `${process.env.BE_API_URL}/api/mcp/tools/owner/${owner_id}`,
        {
          timeout: 10000,
        }
      );

      const owner = response.data;

      // Format owner data for LLM
      return JSON.stringify(
        {
          id: owner.id,
          fullName: owner.fullName,
          phone: owner.phone,
          gender: owner.gender,
          dob: owner.dob,
          bio: owner.bio,
          createdAt: owner.createdAt,
          avatarUrl: owner.avatarUrl,
          job: owner.job,
          isVerified: owner.isVerified,
          verificationDate: owner.verificationDate,
          rooms: owner.rooms,
        },
        null,
        2
      );
    } catch (error) {
      console.error("[Tool: Owner API] Error:", (error as Error).message);
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return `Owner with ID ${owner_id} not found in the system.`;
      }
      return `Error fetching owner details: ${(error as Error).message}`;
    }
  },
  {
    name: "get_owner_details",
    description:
      "Get detailed information about a property owner/landlord from the backend system, including their profile, contact details, and all their listed rooms/properties. Use this when user asks about the landlord, property owner contact info, or wants to see all properties from a specific owner.",
    schema: z.object({
      owner_id: z.string().describe("The owner ID to fetch details for"),
    }) as any, // Avoid deep type instantiation
  }
);
