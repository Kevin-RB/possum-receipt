import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { lmstudio } from "@/lib/ai/provider";

/**
 * The app-owned catalogue of chat models (ADR-0017). This is the only place a
 * chat model can come from: the route validates the client's `{ provider,
 * model }` against it before a model is constructed, and the default is its
 * first entry whose provider has a credential.
 *
 * `price` is a dated snapshot (2026-11-07) for cost review, never shown in the
 * picker and never used for billing.
 */
export interface ChatCatalogueEntry {
  model: string;
  price: { input: number; output: number } | null;
  provider: ChatProviderId;
}

export const chatProviderIds = ["openrouter", "local"] as const;

export type ChatProviderId = (typeof chatProviderIds)[number];

/**
 * Ordered by input price ascending, with `local` last: it is the fallback when
 * no remote credential resolves, not a cheaper hosted option. The default is
 * the first entry whose provider is registered, so a deployment without a key
 * starts on `local` and one with a key starts on the cheapest remote model.
 */
export const CHAT_CATALOGUE: readonly ChatCatalogueEntry[] = [
  {
    model: "deepseek/deepseek-v4.1-flash",
    price: { input: 0.051, output: 0.567 },
    provider: "openrouter",
  },
  {
    model: "anthropic/claude-haiku-5.5",
    price: { input: 0.1, output: 0.5 },
    provider: "openrouter",
  },
  {
    model: "z-ai/glm-5.3-flash",
    price: { input: 0.15, output: 0.5 },
    provider: "openrouter",
  },
  {
    model: "qwen/qwen3.8-27b",
    price: { input: 0.15, output: 1.875 },
    provider: "openrouter",
  },
  {
    model: "google/gemini-3.5-flash-lite",
    price: { input: 0.3, output: 2.5 },
    provider: "openrouter",
  },
  {
    // The exact id LM Studio serves, vendor prefix included. The picker, not
    // this catalogue, shortens the label to `local (gemma-4-e4b)`; reading
    // `PARSE_MODEL` or dropping the vendor here makes local chat 404.
    model: "google/gemma-4-e4b",
    price: null,
    provider: "local",
  },
];

export const chatSelectionSchema = z.object({
  model: z.string().min(1).max(200),
  provider: z.enum(chatProviderIds),
});

export type ChatSelection = z.infer<typeof chatSelectionSchema>;

/**
 * `require_parameters` stops OpenRouter routing to an endpoint that ignores
 * tools; `zdr` keeps the request on endpoints that do not retain prompts.
 * Both are unconditional, which is why every remote entry is curated to have at
 * least one endpoint supporting both.
 */
const OPENROUTER_ROUTING = {
  provider: { require_parameters: true, zdr: true },
} as const;

/**
 * A map from provider to "build a model" rather than `createProviderRegistry`:
 * the SDK registry resolves a bare `provider:model` string, which has nowhere to
 * carry OpenRouter's typed routing settings, and those must be applied to every
 * remote model the catalogue resolves.
 */
type ProviderRegistration = (model: string) => LanguageModel;

/**
 * Built once at module load. With one app-owned credential there is no
 * per-user key to isolate, and a singleton means the route, the evals and the
 * picker all resolve the same registry.
 *
 * `local` is registered only when no remote key resolves, so a deployment with
 * OpenRouter never silently serves the weak local model (ADR-0017).
 */
const registerProviders = (
  openRouterKey: string | undefined
): Partial<Record<ChatProviderId, ProviderRegistration>> => {
  if (openRouterKey) {
    const openrouter = createOpenRouter({ apiKey: openRouterKey });
    return {
      openrouter: (model) => openrouter.chat(model, OPENROUTER_ROUTING),
    };
  }

  return { local: (model) => lmstudio.chatModel(model) };
};

export const chatProviders = registerProviders(process.env.OPENROUTER_API_KEY);

/** The models a reader may pick, or the route may accept, right now. */
const availableChatModels = (): ChatCatalogueEntry[] =>
  CHAT_CATALOGUE.filter((entry) => chatProviders[entry.provider] !== undefined);

/**
 * What the picker offers, and what the route accepts: the same list, in the
 * same order, so the client cannot present an entry the route would refuse.
 * Plain data — `provider` and `model` cross to the browser, the price does not.
 */
export const chatSelections = (): ChatSelection[] =>
  availableChatModels().map(({ model, provider }) => ({ model, provider }));

const defaultChatSelection = (): ChatSelection | null =>
  chatSelections()[0] ?? null;

export interface ResolvedChatModel {
  /** `provider/model`, safe for logs and eval output: it carries no credential. */
  id: string;
  model: LanguageModel;
  selection: ChatSelection;
}

/**
 * A selection to the model the agent runs on, or `null` when the selection is
 * not in the catalogue or its provider has no credential. `undefined` asks for
 * the default, which is how a request that names nothing (the picker has not
 * sent a choice yet) still works.
 */
export const resolveChatModel = (
  selection?: unknown
): ResolvedChatModel | null => {
  const chosen =
    selection === undefined
      ? defaultChatSelection()
      : chatSelectionSchema.safeParse(selection).data;

  if (!chosen) {
    return null;
  }

  const entry = CHAT_CATALOGUE.find(
    (candidate) =>
      candidate.provider === chosen.provider && candidate.model === chosen.model
  );
  const create = chatProviders[chosen.provider];

  if (!entry || !create) {
    return null;
  }

  return {
    id: `${entry.provider}/${entry.model}`,
    model: create(entry.model),
    selection: chosen,
  };
};
