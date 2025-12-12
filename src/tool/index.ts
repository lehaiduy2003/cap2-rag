import { webSearchTool } from "./webSearch";
import { searchKnowledgeBaseTool } from "./searchKb";
import { getOwnerDetailsTool } from "./getOwnerDetail";
import { getPropertyDetailsTool } from "./getRoomDetail";
import { searchRoomsTool } from "./searchRooms";
import { searchNearbyRoomsTool } from "./searchNearbyRooms";
import { compareUtilityPricingTool } from "./compareUtilityPricing";
import { calculateDistanceTool } from "./calculateDistance";

// Avoid deep type instantiation
const agentTools: any[] = [
  webSearchTool,
  searchKnowledgeBaseTool,
  getOwnerDetailsTool,
  getPropertyDetailsTool,
  searchRoomsTool,
  searchNearbyRoomsTool,
  compareUtilityPricingTool,
  calculateDistanceTool,
];

export default agentTools;
