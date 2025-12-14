/**
 * Master Orchestrator Agent
 * Intelligently decides which tools to use to answer user queries
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BufferWindowMemory } from "langchain/memory";
import agentTools from "./tool";
import dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config();

const GOOGLE_API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

if (!GOOGLE_API_KEY) {
  throw new Error("GOOGLE_GEMINI_API_KEY is not set in environment variables");
}

// Load system prompt from markdown file
const SYSTEM_PROMPT_PATH = path.join(__dirname, "prompts", "system-prompt.md");
let systemPrompt: string;

try {
  systemPrompt = fs.readFileSync(SYSTEM_PROMPT_PATH, "utf-8");
} catch (error) {
  console.error("[Orchestrator] Failed to load system prompt:", (error as Error).message);
  throw new Error("System prompt file not found");
}

// Memory storage for conversation sessions
const sessionMemories = new Map<string, BufferWindowMemory>();

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
 * Create the master orchestrator agent
 */
async function createOrchestratorAgent(sessionId: string) {
  // Initialize Gemini model with streaming disabled to avoid tool calling parsing issues
  const model = new ChatGoogleGenerativeAI({
    apiKey: GOOGLE_API_KEY,
    modelName: GEMINI_MODEL,
    temperature: 0.7,
    maxOutputTokens: 2048,
    streaming: false, // Disable streaming to fix "Cannot read properties of undefined (reading 'parts')" error
  });

  // Get or create memory for this session
  const memory = getSessionMemory(sessionId);

  // Create the agent prompt
  const prompt = ChatPromptTemplate.fromMessages([
    ["system", systemPrompt],
    ["placeholder", "{chat_history}"],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]);

  // Create the agent with explicit instructions for parallel tool calls
  const agent = createToolCallingAgent({
    llm: model,
    tools: agentTools as any, // Avoid deep type instantiation
    prompt,
  });

  // Create agent executor with error handling for Gemini function calling quirks
  const executor = new AgentExecutor({
    agent,
    tools: agentTools as any, // Avoid deep type instantiation
    memory,
    verbose: false, // Set to false in production
    maxIterations: 5,
    returnIntermediateSteps: false,
    // Handle parsing errors from Gemini's function calling format
    handleParsingErrors: true,
  });

  return executor;
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
  try {
    // Create agent for this session
    const executor = await createOrchestratorAgent(sessionId);

    // Run the agent
    const result = await executor.invoke({
      input: userMessage,
      property_id: propertyId || "Not specified",
      owner_id: ownerId || "Not specified",
      session_id: sessionId,
    });

    // Handle different types of output
    let responseText: string;

    if (typeof result.output === "string") {
      responseText = result.output;
    } else if (Array.isArray(result.output)) {
      // Handle case where output is an array of function calls (tool calls that weren't executed)
      console.warn(
        "[Orchestrator] Output is an array of function calls - attempting manual execution"
      );

      // Try to manually execute the tool calls
      try {
        const toolCall = result.output[0];
        if (toolCall && toolCall.functionCall) {
          const { name, args } = toolCall.functionCall;
          console.log(`[Orchestrator] Manually executing tool: ${name} with args:`, args);

          // Find and execute the tool
          const tool = agentTools.find((t: any) => t.name === name);
          if (tool) {
            const toolResult = await tool.invoke(args);

            // Re-invoke the agent with the tool result as context
            const followUpResult = await executor.invoke({
              input: `Based on this information from ${name}: ${toolResult}\n\nPlease answer the user's original question: "${userMessage}"`,
              property_id: propertyId || "Not specified",
              owner_id: ownerId || "Not specified",
              session_id: sessionId,
            });

            responseText =
              typeof followUpResult.output === "string"
                ? followUpResult.output
                : "I apologize, but I encountered an issue processing your request. Please try again.";
          } else {
            responseText =
              "I apologize, but I encountered an issue processing your request. Please try again.";
          }
        } else {
          responseText =
            "I apologize, but I encountered an issue processing your request. Please try again.";
        }
      } catch (manualError) {
        console.error(
          "[Orchestrator] Manual tool execution failed:",
          (manualError as Error).message
        );
        responseText =
          "I apologize, but I encountered an issue processing your request. Please try again.";
      }
    } else if (typeof result.output === "object" && result.output !== null) {
      // Handle case where output is an object
      console.warn("[Orchestrator] Output is an object:", result.output);
      responseText =
        "I apologize, but I encountered an issue processing your request. Please try again.";
    } else {
      responseText = String(result.output || "I'm not sure how to respond to that.");
    }

    return {
      response: responseText,
      sources: [], // Tools will log which ones were used
    };
  } catch (error) {
    console.error("[Orchestrator] Error:", (error as Error).message);
    throw new Error(`Orchestrator error: ${(error as Error).message}`);
  }
}
