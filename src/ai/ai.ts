import { createAnthropic } from "@ai-sdk/anthropic";
import { LanguageModel, generateObject } from "ai";
import { ollama } from "ollama-ai-provider-v2";
import { logger } from "../lib/pino";
import { z } from "zod";

const isProduction = process.env.NODE_ENV === "production";

type AIProvider = "openai" | "anthropic";

function detectProvider(): AIProvider {
  const configuredProvider = process.env.AI_PROVIDER?.toLowerCase();
  if (configuredProvider === "anthropic" || configuredProvider === "openai") {
    return configuredProvider;
  }

  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "";
  if (apiKey.startsWith("sk-ant-")) {
    return "anthropic";
  }

  const baseURL =
    process.env.AI_API_BASE_URL ||
    process.env.OPENAI_API_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    "";
  if (baseURL.toLowerCase().includes("anthropic.com")) {
    return "anthropic";
  }

  return "openai";
}

export function getAIConfig() {
  const provider = detectProvider();
  const apiKey = process.env.AI_API_KEY || process.env.OPENAI_API_KEY;
  const modelName =
    process.env.AI_MODEL_NAME ||
    process.env.OPENAI_MODEL_NAME ||
    process.env.ANTHROPIC_MODEL_NAME;
  const baseURL =
    process.env.AI_API_BASE_URL ||
    process.env.OPENAI_API_BASE_URL ||
    process.env.OPENAI_BASE_URL ||
    (provider === "anthropic"
      ? "https://api.anthropic.com/v1"
      : "https://api.openai.com/v1");

  if (!apiKey) {
    throw new Error("Missing AI API key. Set AI_API_KEY or OPENAI_API_KEY.");
  }

  if (!modelName) {
    throw new Error(
      "Missing AI model name. Set AI_MODEL_NAME, OPENAI_MODEL_NAME, or ANTHROPIC_MODEL_NAME.",
    );
  }

  return { provider, apiKey, modelName, baseURL };
}

logger.info(
  { environment: process.env.NODE_ENV, isProduction },
  "Initializing AI model",
);

/**
 * The language model used in non-production for generateObject.
 * In production we use provider-specific chat endpoints directly.
 */
export const model: LanguageModel = isProduction
  ? (() => {
      const { provider, modelName, baseURL } = getAIConfig();
      logger.info(
        {
          provider,
          baseURL,
          model: modelName,
        },
        "Using AI model for production",
      );
      return ollama("dolphin-phi");
    })()
  : (() => {
      logger.info(
        { model: "dolphin-phi" },
        "Using Ollama model for development",
      );
      return ollama("dolphin-phi");
    })();

logger.info("AI model initialized successfully");

/**
 * Use provider-native chat APIs in production (OpenAI or Claude/Anthropic).
 * In development, fall back to ai.generateObject with Ollama.
 *
 * This helper tries to keep behavior identical to previous generateObject
 * usage: it returns an object matching the provided Zod schema as
 * { object: parsed }.
 */
export async function generateObjectChat<T>({
  schema,
  prompt,
  system,
}: {
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
}): Promise<{ object: T }> {
  if (!isProduction) {
    // In non-production use the existing generateObject behaviour (works with ollama)
    return await generateObject(
      system ? { model, schema, prompt, system } : { model, schema, prompt },
    );
  }

  const { provider, baseURL, modelName, apiKey } = getAIConfig();

  if (provider === "anthropic") {
    const anthropicModel = createAnthropic({
      apiKey,
      baseURL,
    })(modelName);

    return await generateObject(
      system
        ? { model: anthropicModel, schema, prompt, system }
        : { model: anthropicModel, schema, prompt },
    );
  }

  const basePath = baseURL.replace(/\/$/, "");

  const res = await fetch(`${basePath}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelName,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      temperature: 0,
      max_tokens: 1000,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error(
      { provider, status: res.status, body: text },
      "AI chat request failed",
    );
    throw new Error(`AI chat request failed (${provider}): ${res.status}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string }; text?: string }>;
  };
  const content: string =
    data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? "";

  // Try to parse JSON from the assistant content. If it fails, throw a helpful error.
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // If assistant returned streaming metadata or extra text, try to extract a JSON block
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        parsed = JSON.parse(match[0]);
      } catch (e2) {
        logger.error(
          { err: e2, content },
          "Failed to parse JSON from chat completion",
        );
        throw e2;
      }
    } else {
      logger.error({ content }, "Chat completion did not return valid JSON");
      throw new Error("Chat completion did not return valid JSON");
    }
  }

  const validated = schema.parse(parsed);
  return { object: validated };
}
