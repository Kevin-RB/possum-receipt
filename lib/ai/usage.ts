import type { ProviderMetadata } from "ai";

/**
 * What one call was billed at, read from the response rather than from the
 * model's price (ADR-0022).
 *
 * `zdr` excludes a model's first-party endpoint, so the `pricing` object on a
 * model is a guess about a call that may never have gone there. In strict
 * compatibility the OpenRouter adapter reports the endpoint that served the
 * call and the amount it charged, and those are the only honest source.
 */
export interface CallCost {
  costUsd: number | null;
  /** The upstream host that served the call, e.g. `Chutes`. */
  host: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
}

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The AI SDK types provider metadata as JSON, so the block is narrowed. */
const isJsonObject = (
  value: unknown
): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const readCallCost = (metadata?: ProviderMetadata): CallCost => {
  const root = metadata?.openrouter;
  const usage = isJsonObject(root?.usage) ? root.usage : null;

  return {
    costUsd: numberOrNull(usage?.cost),
    host: typeof root?.provider === "string" ? root.provider : null,
    inputTokens: numberOrNull(usage?.promptTokens),
    outputTokens: numberOrNull(usage?.completionTokens),
  };
};

/** One line per call, greppable by the scope that made it. */
export const formatCallCost = (
  scope: string,
  model: string,
  cost: CallCost
): string => {
  const amount =
    cost.costUsd === null ? "unknown" : `$${cost.costUsd.toFixed(6)}`;
  const host = cost.host ?? "unknown";
  const tokens = `${cost.inputTokens ?? "?"}in/${cost.outputTokens ?? "?"}out`;

  return `[${scope}] ${model} host=${host} cost=${amount} ${tokens}`;
};
