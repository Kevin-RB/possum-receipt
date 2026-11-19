import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, RetryError, wrapLanguageModel } from "ai";
import type { LanguageModel } from "ai";

import { formatCallCost, readCallCost } from "./usage";

/**
 * The provider every extraction and categorization call runs through (ADR-0022).
 *
 * Chat has its own resolution path — the curated catalogue in
 * `lib/chat/catalogue.ts` — but both end at the same credential, the same
 * adapter and the same routing flags, which is why the flags live here and
 * chat imports them rather than keeping a copy that can drift.
 */
export const OPENROUTER_ROUTING = {
  /**
   * `require_parameters` stops OpenRouter routing to an endpoint that ignores
   * part of the request — a structured-output call landing on an endpoint with
   * no JSON schema support would fail at the model instead of at routing.
   * `zdr` keeps the request on endpoints that do not retain prompts, which is
   * the whole data-policy ground for sending receipts off the host.
   */
  provider: { require_parameters: true, zdr: true },
} as const;

/**
 * `strict` is the mode for OpenRouter's own API: only it reports what a call
 * cost. Without it there is no `providerMetadata.openrouter.usage.cost`, and
 * the price of a call is exactly the number ADR-0022 insists on reading from
 * the call that ran rather than from the model's price list.
 */
const openrouter = createOpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
  compatibility: "strict",
});

/**
 * Whether extraction has a credential at all. A deployment without one cannot
 * extract, and the run says so in the app's own words (ADR-0014) instead of
 * failing with the adapter's message about a missing key.
 */
export const openRouterConfigured = (): boolean =>
  Boolean(process.env.OPENROUTER_API_KEY);

/**
 * Whether a provider failure is worth another attempt.
 *
 * `generateText` runs its own retries (`maxRetries: 1` here) and reports the
 * last failure wrapped in a `RetryError`, so the error a step sees is **not**
 * the `APICallError` that knows whether it is retryable. Classifying the
 * wrapper alone reports every rate limit and every 5xx as permanent, which is
 * the opposite of what ADR-0022 relies on: "this is a background run whose
 * failure is visible on the receipt and retryable in Inngest". So the wrapper
 * is unwrapped to the failure underneath, which is the only thing that knows.
 */
export const isRetryableProviderFailure = (error?: unknown): boolean => {
  if (RetryError.isInstance(error)) {
    return isRetryableProviderFailure(error.lastError);
  }

  return APICallError.isInstance(error) && error.isRetryable;
};

const settings = {
  ...OPENROUTER_ROUTING,
  /**
   * Reasoning is the cost trap: a thousand stray reasoning tokens double a call
   * that should cost a fraction of a cent, and none of these prompts asks the
   * model to think. `usage` is what makes the response carry the billed cost.
   */
  reasoning: { effort: "none" },
  usage: { include: true },
} as const;

/**
 * A model that answers with structured output under the extraction settings,
 * and reports each call's measured cost as it happens.
 *
 * The reporting sits in a middleware rather than at the two call sites because
 * it is the same obligation for both, it needs the model id and the response
 * metadata that only the call itself has, and a third call site cannot forget
 * it. Every attempt is logged, retries included, because every attempt is
 * billed.
 */
export const extractionModel = (
  model: string,
  scope: "categorize" | "extraction"
): LanguageModel =>
  wrapLanguageModel({
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        console.info(
          formatCallCost(scope, model, readCallCost(result.providerMetadata))
        );
        return result;
      },
    },
    model: openrouter.chat(model, settings),
  });
