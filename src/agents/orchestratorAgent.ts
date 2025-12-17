/**
 * Master Orchestrator Agent (Client)
 * Handles basic conversations and delegates complex queries to Information Provider Agent
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BufferWindowMemory } from "langchain/memory";
import { queryInfoProvider } from "./informationProviderAgent";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

if (!GOOGLE_API_KEY) {
  throw new Error("GOOGLE_GEMINI_API_KEY is not set in environment variables");
}

// Load system prompt from markdown file
const ORCHESTRATOR_PROMPT_PATH = path.join(__dirname, "prompts", "orchestrator-prompt.md");
let orchestratorPrompt: string;

try {
  orchestratorPrompt = fs.readFileSync(ORCHESTRATOR_PROMPT_PATH, "utf-8");

  if (!orchestratorPrompt || !orchestratorPrompt.trim()) {
    throw new Error("Orchestrator prompt file is empty");
  }
} catch (error) {
  console.error("[Orchestrator] Failed to load system prompt:", (error as Error).message);
  console.error("[Orchestrator] Attempted path:", ORCHESTRATOR_PROMPT_PATH);
  throw new Error(`Orchestrator prompt file error: ${(error as Error).message}`);
}

// Memory storage for conversation sessions
const sessionMemories = new Map<string, BufferWindowMemory>();

// Concurrency control - limit simultaneous requests to prevent overload
const MAX_CONCURRENT_REQUESTS = 5;
let activeRequests = 0;
const requestQueue: Array<() => void> = [];

/**
 * Acquire a slot for processing a request
 */
async function acquireRequestSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT_REQUESTS) {
    activeRequests++;
    return Promise.resolve();
  }

  // Wait in queue
  return new Promise<void>((resolve) => {
    requestQueue.push(resolve);
  });
}

/**
 * Release a request slot and process next in queue
 */
function releaseRequestSlot(): void {
  activeRequests--;
  const next = requestQueue.shift();
  if (next) {
    activeRequests++;
    next();
  }
}

/**
 * Get or create memory for a session
 */
function getSessionMemory(sessionId: string): BufferWindowMemory {
  if (!sessionMemories.has(sessionId)) {
    sessionMemories.set(
      sessionId,
      new BufferWindowMemory({
        k: 6, // Keep last 6 messages (3 exchanges)
        returnMessages: true,
        memoryKey: "chat_history",
        inputKey: "input",
        outputKey: "output",
      })
    );
  }
  return sessionMemories.get(sessionId)!;
}

/**
 * Clear memory for a session
 */
export function clearSessionMemory(sessionId: string): void {
  sessionMemories.delete(sessionId);
  console.log(`[Orchestrator] Cleared memory for session: ${sessionId}`);
}

/**
 * Get chat history for a session
 */
export async function getSessionHistory(sessionId: string): Promise<any[]> {
  const memory = sessionMemories.get(sessionId);
  if (!memory) {
    return [];
  }

  const history = await memory.loadMemoryVariables({});
  return history.chat_history || [];
}

/**
 * Create the orchestrator client (no tools, just decision-making)
 */
async function createOrchestratorClient(sessionId: string) {
  if (!GOOGLE_API_KEY) {
    throw new Error("GOOGLE_GEMINI_API_KEY is not configured");
  }

  const model = new ChatGoogleGenerativeAI({
    apiKey: GOOGLE_API_KEY,
    modelName: GEMINI_MODEL,
    temperature: 0.5, // Moderate temperature for natural conversation
    maxOutputTokens: 1024,
    streaming: false,
    maxRetries: 2,
  });

  const memory = getSessionMemory(sessionId);

  if (!orchestratorPrompt || !orchestratorPrompt.trim()) {
    throw new Error("Orchestrator prompt is empty or not loaded");
  }

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", orchestratorPrompt],
    ["placeholder", "{chat_history}"],
    ["human", "{input}"],
  ]);

  return { model, prompt, memory };
}

/**
 * Run the orchestrator agent for a chat message
 */
export async function runOrchestrator(
  sessionId: string,
  userMessage: string,
  propertyId?: number,
  ownerId?: string
): Promise<{
  response: string;
  sources?: any[];
}> {
  await acquireRequestSlot();

  try {
    // Validate input
    if (!userMessage || typeof userMessage !== "string" || !userMessage.trim()) {
      throw new Error("Invalid or empty user message");
    }

    if (!sessionId || typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("Invalid or empty session ID");
    }

    console.log(
      `[Orchestrator] Processing message: "${userMessage.substring(
        0,
        50
      )}..." for session: ${sessionId} (Active requests: ${activeRequests}/${MAX_CONCURRENT_REQUESTS})`
    );

    // Create orchestrator client
    const { model, prompt, memory } = await createOrchestratorClient(sessionId);

    // Load chat history
    const memoryVariables = await memory.loadMemoryVariables({});
    const chatHistory = memoryVariables.chat_history || [];

    // Prepare initial decision prompt
    const inputData = {
      input: userMessage.trim(),
      property_id: propertyId || "Not specified",
      owner_id: ownerId || "Not specified",
      session_id: sessionId,
      chat_history: chatHistory,
    };

    console.log(`[Orchestrator] Analyzing query type...`);

    // Determine if this is a basic query or needs delegation
    const isBasicQuery =
      /^(hi|hello|hey|xin chào|chào|cảm ơn|thank|bye|goodbye|tạm biệt|help|what is|gì là)/i.test(
        userMessage.trim()
      );

    let responseText: string;

    if (isBasicQuery) {
      // Handle directly with orchestrator
      console.log(`[Orchestrator] Handling basic query directly`);

      const directPrompt = await prompt.formatMessages(inputData);
      const directResponse: any = await model.invoke(directPrompt);
      responseText =
        typeof directResponse.content === "string"
          ? directResponse.content
          : String(directResponse.content);

      console.log(`[Orchestrator] Direct response provided`);
    } else {
      // Delegate to Information Provider Agent
      console.log(`[Orchestrator] Delegating to Information Provider...`);

      const infoResult = await queryInfoProvider(userMessage, propertyId, ownerId);

      if (infoResult.success) {
        // Add friendly context to the information provider's response
        const contextPrompt = await prompt.formatMessages({
          ...inputData,
          chat_history: chatHistory,
          input: `The user asked: "${userMessage}"

I retrieved this information: ${infoResult.answer}

Present this information to the user in a friendly, natural way. You can add a brief introduction or offer to help further, but keep the core information intact.`,
        });

        const finalResponse: any = await model.invoke(contextPrompt);
        responseText =
          typeof finalResponse.content === "string"
            ? finalResponse.content
            : String(finalResponse.content);

        console.log(
          `[Orchestrator] Delegated successfully - Tools used: ${infoResult.toolsUsed.join(", ")}`
        );
      } else {
        responseText = infoResult.answer; // Error message from info provider
      }
    }

    // Save to memory
    await memory.saveContext({ input: userMessage }, { output: responseText });

    return {
      response: responseText,
      sources: [],
    };
  } catch (error) {
    const errorMessage = (error as Error).message;
    console.error("[Orchestrator] Error:", errorMessage);

    if (errorMessage.includes("timeout")) {
      throw new Error("Yêu cầu mất quá nhiều thời gian. Vui lòng thử lại.");
    } else if (errorMessage.includes("API key")) {
      throw new Error("Lỗi cấu hình hệ thống. Vui lòng liên hệ quản trị viên.");
    } else if (errorMessage.includes("rate limit") || errorMessage.includes("quota")) {
      throw new Error("Hệ thống đang quá tải. Vui lòng thử lại sau ít phút.");
    }

    throw new Error(`Lỗi xử lý: ${errorMessage}`);
  } finally {
    releaseRequestSlot();
  }
}
