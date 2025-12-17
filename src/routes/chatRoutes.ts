/**
 * Chat Routes
 * Handles chat-related API endpoints with RAG and memory
 */

import { Router, Request, Response } from "express";
import {
  runOrchestrator,
  getSessionHistory,
  clearSessionMemory,
} from "../agents";

/**
 * Create chat routes
 */
export function createChatRoutes(): Router {
  const router = Router();

  /**
   * POST /api/rag/chat
   * Chat with AI using RAG and conversation memory
   * Memory keeps last 6 messages (3 exchanges) per session
   */
  router.post("/", async (req: Request, res: Response): Promise<any> => {
    try {
      const { message, session_id, property_id, owner_id, user_id } = req.body;

      // Validate message
      if (!message || typeof message !== "string" || !message.trim()) {
        console.error("[RAG API] Invalid message:", { message, type: typeof message });
        return res.status(400).json({
          error: "Message is required and must be a non-empty string",
          received: { message, type: typeof message },
        });
      }

      if (!property_id && !owner_id) {
        return res.status(400).json({
          error: "Either property_id or owner_id is required for context",
        });
      }

      // Create session ID if not provided (userId-propertyId or userId-ownerId)
      const sessionId =
        session_id ||
        `${user_id || "guest"}-${property_id ? `property-${property_id}` : `owner-${owner_id}`}`;

      console.log(
        `[RAG API] Chat request - Session: ${sessionId}, Property: ${property_id}, Owner: ${owner_id}, Message: "${message.substring(
          0,
          50
        )}..."`
      );

      // Use orchestrator agent for intelligent tool selection
      const result = await runOrchestrator(
        sessionId,
        message,
        property_id ? Number(property_id) : undefined,
        owner_id?.toString()
      );

      res.json({
        success: true,
        session_id: sessionId,
        response: result.response,
        sources: result.sources || [],
      });
    } catch (error) {
      console.error("[RAG API] Error in chat:", (error as Error).message);
      res.status(500).json({
        error: "Failed to process chat message",
        details: (error as Error).message,
      });
    }
  });

  /**
   * GET /api/rag/chat/history/:session_id
   * Get chat history for a session
   */
  router.get("/history/:session_id", async (req: Request, res: Response): Promise<any> => {
    try {
      const { session_id } = req.params;

      if (!session_id) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const history = await getSessionHistory(session_id);

      res.json({
        session_id,
        history,
        message_count: history.length,
      });
    } catch (error) {
      console.error("[RAG API] Error getting chat history:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  /**
   * DELETE /api/rag/chat/:session_id
   * Clear chat history for a session
   */
  router.delete("/:session_id", async (req: Request, res: Response): Promise<any> => {
    try {
      const { session_id } = req.params;

      if (!session_id) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      clearSessionMemory(session_id);

      res.json({
        success: true,
        message: `Chat history cleared for session: ${session_id}`,
      });
    } catch (error) {
      console.error("[RAG API] Error clearing chat history:", (error as Error).message);
      res.status(500).json({ error: (error as Error).message });
    }
  });

  return router;
}
