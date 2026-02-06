import { createOpenAI } from "@ai-sdk/openai";
import { LanguageModel } from "ai";
import { ollama } from "ollama-ai-provider-v2";
import { logger } from "../lib/pino";

const isProduction = process.env.NODE_ENV === "production";

logger.info(
  { environment: process.env.NODE_ENV, isProduction },
  "Initializing AI model",
);

/**
 * The language model used throughout the app.
 * Uses OpenAI in production, Ollama locally for dev.
 */
export const model: LanguageModel = isProduction
  ? (() => {
      logger.info(
        {
          baseURL: process.env.OPENAI_API_BASE_URL,
          model: process.env.OPENAI_MODEL_NAME,
        },
        "Using OpenAI model for production",
      );
      return createOpenAI({
        apiKey: process.env.OPENAI_API_KEY!,
        baseURL: process.env.OPENAI_API_BASE_URL!,
      })(process.env.OPENAI_MODEL_NAME!);
    })()
  : (() => {
      logger.info(
        { model: "dolphin-phi" },
        "Using Ollama model for development",
      );
      return ollama("dolphin-phi");
    })();

logger.info("AI model initialized successfully");
