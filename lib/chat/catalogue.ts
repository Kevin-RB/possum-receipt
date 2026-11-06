/**
 * Prototype only. The launch catalogue from #209, hardcoded so the picker can
 * be looked at before the env-driven registry (#207) exists.
 *
 * The real thing resolves from env: OpenRouter entries appear only with
 * `OPENROUTER_API_KEY` set, `local` is listed only when no remote key resolves,
 * and the first entry that resolves is the default.
 */

export interface CatalogueEntry {
  provider: "openrouter" | "local";
  model: string;
}

/** The id LM Studio serves, without the quant suffix. */
export const LOCAL_MODEL = "gemma-4-e4b";

/** Cheapest first; the default is the first entry that resolves. */
const OPENROUTER_MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "anthropic/claude-haiku-5.5",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-27b",
  "google/gemini-3.5-flash-lite",
];

export const remoteCatalogue: CatalogueEntry[] = OPENROUTER_MODELS.map(
  (model) => ({ model, provider: "openrouter" })
);

export const localCatalogue: CatalogueEntry[] = [
  { model: LOCAL_MODEL, provider: "local" },
];

/**
 * The raw model id is the label. `local` is the one exception: the id alone
 * does not say what is running behind it, so it names the model too.
 */
export const labelOf = (entry: CatalogueEntry) =>
  entry.provider === "local" ? `local (${entry.model})` : entry.model;

/** One string per entry, for the radio group, which takes strings. */
export const keyOf = (entry: CatalogueEntry) =>
  `${entry.provider}/${entry.model}`;
