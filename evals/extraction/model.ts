import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { APICallError, wrapLanguageModel } from "ai";
import type { LanguageModel, ProviderMetadata } from "ai";

import type { CallRecord, ErrorDetail, Meter, Routing } from "./types";

/**
 * The model under test. A dated revision, because the undated alias resolves to
 * a different (and much more expensive) snapshot — the same reason chat's
 * catalogue pins it.
 */
export const MODEL_ID = "deepseek/deepseek-v4.1-flash-1017";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * `fp8` routing restricts endpoints to fp8 and bf16 quantizations. DeepSeek is
 * served by ~50 third-party hosts, mostly quantized; this is the "compare like
 * with like" arm of the matrix.
 */
const FP8_QUANTIZATIONS: ("fp8" | "bf16")[] = ["fp8", "bf16"];

/**
 * A call-level ceiling used only by the runaway guard, not a prediction. One
 * image call measured at well under a cent, so a cent is a generous bound.
 */
const PER_CALL_CEILING_USD = 0.01;

let provider: ReturnType<typeof createOpenRouter> | null = null;

/**
 * Built once, lazily: the module is imported by unit tests that must not need a
 * key. `compatibility: "strict"` is what makes the adapter ask OpenRouter for
 * usage accounting, and the usage accounting is where the per-call cost comes
 * from — the same reason `lib/chat/catalogue.ts` sets it.
 */
const openRouter = (): ReturnType<typeof createOpenRouter> => {
  if (!provider) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OPENROUTER_API_KEY is not set. Point the script at .env.local with --env-file."
      );
    }
    provider = createOpenRouter({ apiKey, compatibility: "strict" });
  }
  return provider;
};

export interface ModelOptions {
  routing: Routing;
  /**
   * `structuredOutputs.strict`. Production's contract is not OpenAI-strict
   * compatible, so a provider that enforces strict mode rejects it; the smoke
   * test is what finds out, and the matrix then runs on whatever worked.
   */
  strict: boolean;
}

/** Every request carries the same data-policy and accounting settings. */
export const modelSettings = ({ routing, strict }: ModelOptions) => ({
  provider: {
    require_parameters: true,
    zdr: true,
    ...(routing === "fp8" ? { quantizations: FP8_QUANTIZATIONS } : {}),
  },
  reasoning: { effort: "none" as const },
  usage: { include: true },
  ...(strict ? {} : { structuredOutputs: { strict: false } }),
});

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/**
 * The AI SDK types provider metadata as `Record<string, JSONObject>`, whose
 * values are JSON unions. This narrows one of them to a keyed object without a
 * cast: `Array.isArray` alone leaves the readonly-array half of the union in
 * place, so the check is written as a type predicate.
 */
const isJsonObject = (
  value: unknown
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Reads the one block OpenRouter always populates in strict mode:
 * `providerMetadata.openrouter.provider` (the serving host) and `.usage.cost`
 * (what the call was billed at). Typed as `Record<string, JSONObject>` by the
 * AI SDK, so each field is narrowed rather than cast.
 */
export const readOpenRouterMetadata = (
  metadata: ProviderMetadata | undefined
): Pick<CallRecord, "cost" | "host" | "inputTokens" | "outputTokens"> => {
  const root = metadata?.openrouter;
  const host =
    typeof root?.provider === "string" && root.provider !== ""
      ? root.provider
      : null;
  const usage = isJsonObject(root?.usage) ? root.usage : null;

  return {
    cost: numberOrNull(usage?.cost),
    host,
    inputTokens: numberOrNull(usage?.promptTokens),
    outputTokens: numberOrNull(usage?.completionTokens),
  };
};

/** Thrown by the guard *before* a call that could pass the spend limit. */
export class SpendAbortError extends Error {
  override name = "SpendAbortError";
}

/** The `Error.cause` chain and `RetryError.lastError`, innermost first. */
const unwrapError = (error: unknown): unknown => {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) {
      return current;
    }
    const nested = current as Error & {
      cause?: unknown;
      lastError?: unknown;
    };
    const next = nested.lastError ?? nested.cause;
    if (next === undefined || next === null) {
      return current;
    }
    current = next;
  }
  return current;
};

/**
 * The exact failure: the API status, message and response body are all carried
 * through. A `RetryError` is unwrapped so the report names the provider's
 * answer rather than "retries exhausted".
 */
export const describeError = (error: unknown): ErrorDetail => {
  const root = unwrapError(error);

  if (APICallError.isInstance(root)) {
    return {
      message: root.message,
      name: root.name,
      ...(root.responseBody === undefined
        ? {}
        : { responseBody: root.responseBody }),
      ...(root.statusCode === undefined ? {} : { statusCode: root.statusCode }),
      url: root.url,
    };
  }

  if (root instanceof Error) {
    return { message: root.message, name: root.name };
  }

  return { message: String(root), name: "UnknownError" };
};

/**
 * Whether the provider refused the *schema envelope* rather than the request.
 * This is the one failure the owner allowed to be retried with
 * `structuredOutputs.strict: false`: it says nothing about whether the model
 * can read a receipt, only that OpenRouter's strict JSON-schema mode rejects a
 * contract with optional properties and defaults.
 */
export const isStrictSchemaRejection = (error: unknown): boolean => {
  const root = unwrapError(error);
  if (!APICallError.isInstance(root)) {
    return false;
  }
  const text = `${root.message}\n${root.responseBody ?? ""}`;
  const status = root.statusCode;
  return (
    status !== undefined &&
    status >= 400 &&
    status < 500 &&
    /json_schema|response_format|structured output|strict/iu.test(text)
  );
};

/**
 * A model whose every attempt is measured into `meter`, including an attempt
 * that throws. Measured rather than read off the final step because a failed
 * response validation is thrown *after* the HTTP call succeeded, and that call
 * still cost money and still took time.
 *
 * `guard`, when given, is charged here at the one point every call passes
 * through, so a run aborted mid-way cannot lose the cost of the call it already
 * made.
 */
export const createMeteredModel = (
  options: ModelOptions,
  meter: Meter,
  guard?: SpendGuard
): LanguageModel =>
  wrapLanguageModel({
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        const startedAt = Date.now();
        try {
          const result = await doGenerate();
          const metadata = readOpenRouterMetadata(result.providerMetadata);
          meter.calls.push({
            ...metadata,
            error: null,
            latencyMs: Date.now() - startedAt,
          });
          guard?.charge(metadata.cost);
          return result;
        } catch (error) {
          meter.calls.push({
            cost: null,
            error: describeError(error).message,
            host: null,
            inputTokens: null,
            latencyMs: Date.now() - startedAt,
            outputTokens: null,
          });
          throw error;
        }
      },
    },
    model: openRouter().chat(MODEL_ID, modelSettings(options)),
  });

/**
 * The runaway guard: a hard stop at cumulative measured spend, checked before
 * every request. It is not a budget the owner set; it exists so a bug (an
 * unbounded loop, a mis-set variant list) cannot cost more than a dollar.
 *
 * A factory rather than a class because the only state is the running total,
 * and a closure makes "every call is charged exactly once" the only way to use
 * it.
 */
export interface SpendGuard {
  assertCanSpend: () => void;
  charge: (cost: number | null) => void;
  exceeded: () => boolean;
  spent: () => number;
}

export const createSpendGuard = (
  limitUsd = 1,
  perCallCeilingUsd = PER_CALL_CEILING_USD
): SpendGuard => {
  let spentUsd = 0;

  return {
    assertCanSpend: () => {
      if (spentUsd + perCallCeilingUsd > limitUsd) {
        throw new SpendAbortError(
          `Spend guard: $${spentUsd.toFixed(4)} measured, and one more call could pass the $${limitUsd.toFixed(2)} limit. Stopped before the call.`
        );
      }
    },
    charge: (cost) => {
      if (cost !== null && Number.isFinite(cost)) {
        spentUsd += cost;
      }
    },
    exceeded: () => spentUsd > limitUsd,
    spent: () => spentUsd,
  };
};
