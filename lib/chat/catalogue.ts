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
 * starts on `local`, and one with a key starts on the cheapest remote model.
 * A development run with a key offers `local` beneath the remote entries
 * without moving the default — see `offersLocal`.
 *
 * Prices are a snapshot (2026-11-08) and are re-read before a promotion, as
 * ADR-0017 requires. The list is one remote model plus `local`: the price tail
 * went first, and the models that survived it lost to this one on the eval
 * suite — see the ADR for the numbers.
 */
export const CHAT_CATALOGUE: readonly ChatCatalogueEntry[] = [
  {
    // A dated revision, for the one case ADR-0017 allows it: the undated
    // `deepseek/deepseek-v4.1-flash` alias is pinned to the 2026-09-10 revision
    // at 8.5× this input price.
    model: "deepseek/deepseek-v4.1-flash-1017",
    price: { input: 0.006, output: 0.5 },
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
 * Whether `local` is listed. It always is when no remote key resolves, because
 * then it is the only model there is. It is *also* listed beside a remote key
 * in development, so both can be compared from one picker without unsetting the
 * key and restarting — which is the only way to try a local change against each
 * end of the range.
 *
 * A deployment keeps the single remote row: offering the weak local model to
 * readers is the "quality lottery" ADR-0017 rejects, so the gate is `NODE_ENV`
 * rather than the presence of the key, the same way `DEV_TIMEZONE` stands in for
 * the edge in `lib/viewer.ts`.
 */
const offersLocal = (openRouterKey: string | undefined): boolean =>
  !openRouterKey || process.env.NODE_ENV === "development";

/**
 * Built once at module load. With one app-owned credential there is no
 * per-user key to isolate, and a singleton means the route, the evals and the
 * picker all resolve the same registry (ADR-0017).
 */
const registerProviders = (
  openRouterKey: string | undefined
): Partial<Record<ChatProviderId, ProviderRegistration>> => {
  const providers: Partial<Record<ChatProviderId, ProviderRegistration>> = {};

  if (openRouterKey) {
    // `strict` is the mode for OpenRouter's own API: the adapter sends
    // `stream_options.include_usage` only in it, so a `compatible` instance
    // never reports what a question cost. It leaves `provider` routing flags
    // alone, so `require_parameters` and `zdr` are unaffected.
    const openrouter = createOpenRouter({
      apiKey: openRouterKey,
      compatibility: "strict",
    });
    providers.openrouter = (model) =>
      openrouter.chat(model, OPENROUTER_ROUTING);
  }

  if (offersLocal(openRouterKey)) {
    providers.local = (model) => lmstudio.chatModel(model);
  }

  return providers;
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
