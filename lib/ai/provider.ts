import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export const LM_STUDIO_URL =
  process.env.LM_STUDIO_URL ?? "http://localhost:1234/v1";

export const lmstudio = createOpenAICompatible({
  baseURL: LM_STUDIO_URL,
  name: "lmstudio",
  supportsStructuredOutputs: true,
});

export const ORC_MODEL = process.env.ORC_MODEL ?? "glm-ocr";

export const PARSE_MODEL = process.env.PARSE_MODEL ?? "google/gemma-4-e4b";

export const CATEGORIZE_MODEL = process.env.CATEGORIZE_MODEL ?? PARSE_MODEL;
