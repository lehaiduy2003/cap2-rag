/**
 * Information Provider Agent
 * Responsible for executing tools and retrieving specific information
 */

import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { AgentExecutor, createToolCallingAgent } from "langchain/agents";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import agentTools from "../tool";
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
const INFO_PROVIDER_PROMPT_PATH = path.join(__dirname, "prompts", "info-provider-prompt.md");
let infoProviderPrompt: string;

try {
  infoProviderPrompt = fs.readFileSync(INFO_PROVIDER_PROMPT_PATH, "utf-8");

  if (!infoProviderPrompt || !infoProviderPrompt.trim()) {
    throw new Error("Information Provider prompt file is empty");
  }
} catch (error) {
  console.error("[InfoProvider] Failed to load prompt:", (error as Error).message);
  console.error("[InfoProvider] Attempted path:", INFO_PROVIDER_PROMPT_PATH);
  throw new Error(`Information Provider prompt file error: ${(error as Error).message}`);
}

/**
 * Create the information provider agent
 */
async function createInfoProviderAgent() {
  const model = new ChatGoogleGenerativeAI({
    apiKey: GOOGLE_API_KEY,
    modelName: GEMINI_MODEL,
    temperature: 0.2, // Low temperature for precise tool calling
    maxOutputTokens: 2048,
    streaming: false,
    maxRetries: 2,
  });

  const prompt = ChatPromptTemplate.fromMessages([
    ["system", infoProviderPrompt],
    ["human", "{input}"],
    ["placeholder", "{agent_scratchpad}"],
  ]);

  const agent = createToolCallingAgent({
    llm: model,
    tools: agentTools as any,
    prompt,
  });

  const executor = new AgentExecutor({
    agent,
    tools: agentTools as any,
    verbose: false,
    maxIterations: 3,
    returnIntermediateSteps: true, // Return tool execution details
    handleParsingErrors: true,
    earlyStoppingMethod: "generate",
  });

  return executor;
}

/**
 * Query the information provider agent
 */
export async function queryInfoProvider(
  query: string,
  propertyId?: number,
  ownerId?: string
): Promise<{
  answer: string;
  toolsUsed: string[];
  success: boolean;
}> {
  try {
    console.log(`[InfoProvider] Processing query: "${query.substring(0, 50)}..."`);

    const executor = await createInfoProviderAgent();

    const inputData = {
      input: query,
      property_id: propertyId || "Not specified",
      owner_id: ownerId || "Not specified",
    };

    // Execute with timeout
    const result: any = await Promise.race([
      executor.invoke(inputData),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Info provider timeout after 30 seconds")), 30000)
      ),
    ]);

    // Handle different output types
    let answer: string;
    const toolsUsed: string[] = [];

    // Extract tools used from intermediate steps
    if (result.intermediateSteps && Array.isArray(result.intermediateSteps)) {
      result.intermediateSteps.forEach((step: any) => {
        if (step.action && step.action.tool) {
          toolsUsed.push(step.action.tool);
        }
      });
    }

    if (typeof result.output === "string") {
      answer = result.output;
      console.log(`[InfoProvider] Success - Tools used: ${toolsUsed.join(", ") || "none"}`);
      return { answer, toolsUsed, success: true };
    } else if (Array.isArray(result.output)) {
      // Handle case where tools weren't executed - execute them manually
      console.warn("[InfoProvider] Manual tool execution needed");

      const toolResults = await Promise.all(
        result.output.map(async (toolCall: any) => {
          if (toolCall && toolCall.functionCall) {
            const { name, args } = toolCall.functionCall;
            console.log(`[InfoProvider] Executing tool: ${name}`);
            toolsUsed.push(name);

            const tool = agentTools.find((t: any) => t.name === name);
            if (tool) {
              try {
                const toolResult = await tool.invoke(args);
                return { tool: name, result: toolResult, success: true };
              } catch (toolError) {
                console.error(`[InfoProvider] Tool ${name} failed:`, (toolError as Error).message);
                return { tool: name, error: (toolError as Error).message, success: false };
              }
            }
          }
          return null;
        })
      );

      const validResults = toolResults.filter((r: any) => r !== null);
      const successfulResults = validResults.filter((r: any) => r.success);

      if (successfulResults.length > 0) {
        // Format results for LLM to generate natural response
        const toolContext = successfulResults
          .map((r: any) => {
            const resultStr =
              typeof r.result === "string" ? r.result : JSON.stringify(r.result, null, 2);
            return `Tool: ${r.tool}\nResult: ${resultStr}`;
          })
          .join("\n\n---\n\n");

        // Use simple LLM to format the response
        const simpleModel = new ChatGoogleGenerativeAI({
          apiKey: GOOGLE_API_KEY,
          modelName: GEMINI_MODEL,
          temperature: 0.3,
          maxOutputTokens: 1024,
          streaming: false,
        });

        const responsePrompt = `You are providing information for SafeNestly property rental platform.

Original query: "${query}"

Tool results:
${toolContext}

Based on this information, provide a clear, natural response. Respond in ${
          query.match(/[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i)
            ? "Vietnamese"
            : "English"
        }.`;

        const llmResponse = await simpleModel.invoke(responsePrompt);
        answer =
          typeof llmResponse.content === "string"
            ? llmResponse.content
            : String(llmResponse.content);

        console.log(`[InfoProvider] Success - Tools used: ${toolsUsed.join(", ")}`);
        return { answer, toolsUsed, success: true };
      } else {
        console.error("[InfoProvider] All tools failed");
        return {
          answer: "Không thể lấy thông tin lúc này.",
          toolsUsed,
          success: false,
        };
      }
    } else {
      console.warn("[InfoProvider] Unexpected output type:", typeof result.output);
      return {
        answer: String(result.output || "Không có thông tin."),
        toolsUsed,
        success: false,
      };
    }
  } catch (error) {
    console.error("[InfoProvider] Error:", (error as Error).message);
    return {
      answer: `Lỗi khi lấy thông tin: ${(error as Error).message}`,
      toolsUsed: [],
      success: false,
    };
  }
}
