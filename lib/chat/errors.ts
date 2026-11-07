import { AISDKError, APICallError, RetryError, StreamProviderError } from "ai";
import { DrizzleQueryError } from "drizzle-orm";

import { isUserMessage, USER_ERROR } from "@/lib/errors";

type ChatErrorCode = "busy" | "generic" | "modelUnavailable";

/**
 * `maxRetries` (2 by default) reports the last failure inside a `RetryError`,
 * so the error the route receives is not the `APICallError` holding the cause.
 * Verified against `ai@7`: a model server that is down arrives as
 * `RetryError.lastError` → `APICallError` "Cannot connect to API: …".
 */
const unwrapRetries = (error: unknown): unknown =>
  RetryError.isInstance(error) ? unwrapRetries(error.lastError) : error;

/**
 * A provider failure is the AI SDK's own error type. Two shapes reach the
 * route: `APICallError` before a stream exists, and `StreamProviderError` once
 * one does, where the status rides on the payload rather than the wire. Both
 * are classified the same way, so a second remote provider adds no classifier.
 */
const providerStatus = (
  error: unknown
): { found: true; statusCode: number | undefined } | { found: false } => {
  if (APICallError.isInstance(error)) {
    return { found: true, statusCode: error.statusCode };
  }
  if (StreamProviderError.isInstance(error)) {
    return { found: true, statusCode: error.statusCode };
  }
  return { found: false };
};

/**
 * ADR-0014's status map, exhaustive on purpose: every provider status lands in
 * exactly one row, so there is none left to judge at a call site.
 *
 * `busy` is the only code a reader can act on, and it is one sentence because
 * waiting is the instruction. A dead key, an unknown model id and an exhausted
 * balance are the operator's problem delivered to whoever is looking at the
 * screen, so they share the outage line and are told apart in the log alone.
 *
 * 409 and the remaining 5xx sit in `busy` because the SDK has already retried
 * them twice and the reader's next action is the same as for a 429.
 */
const codeForStatus = (statusCode: number | undefined): ChatErrorCode => {
  if (statusCode === undefined) {
    // A provider failure with no status: the connection never completed, or the
    // provider reported an error without one.
    return "modelUnavailable";
  }
  if (statusCode === 200) {
    // A two-hundred carrying an error is a failure, not a success.
    return "modelUnavailable";
  }
  if (statusCode === 408 || statusCode === 409 || statusCode === 429) {
    return "busy";
  }
  if (statusCode >= 500) {
    return "busy";
  }
  if (
    statusCode === 401 ||
    statusCode === 402 ||
    statusCode === 403 ||
    statusCode === 404
  ) {
    return "modelUnavailable";
  }
  return "generic";
};

/**
 * Every failed provider call — a rate limit, a dead key, an exhausted balance,
 * a model the server does not serve — means one of three things to the person
 * waiting. The distinctions that do not change what they should do stay in the
 * server log, where they are actionable.
 */
export const chatErrorCode = (error: unknown): ChatErrorCode => {
  const failure = providerStatus(unwrapRetries(error));

  return failure.found ? codeForStatus(failure.statusCode) : "generic";
};

/**
 * A turn can also fail before a stream exists — a 401 from an expired session,
 * a 500 from the framework, a dropped connection — and there the message is a
 * JSON body or an HTML page, not wording written for a reader. Only text this
 * app wrote is shown; an expired session is the one such failure with a
 * readable status, and everything else collapses to the generic line.
 */
export const chatErrorText = (error: Error): string => {
  if (isUserMessage(error.message)) {
    return error.message;
  }
  if (APICallError.isInstance(error) && error.statusCode === 401) {
    return USER_ERROR.unauthorized;
  }
  return USER_ERROR.generic;
};

/** The pieces of a chat failure worth keeping after the request ends. */
export interface ChatFailureLog {
  code: ChatErrorCode;
  isRetryable?: boolean;
  /**
   * Only for errors the AI SDK did not raise — a tool's storage failure, say,
   * where the message is the diagnosis. See `chatFailureLog`.
   */
  message?: string;
  model: string;
  name: string;
  origin?: string;
  /**
   * A failed query, as the statement alone: repo-authored SQL with placeholders
   * where the bound values go. Drizzle's own message appends those values, and
   * for a search they are the reader's words.
   */
  statement?: string;
  /** PostgreSQL's five-character SQLSTATE from the driver error underneath. */
  sqlState?: string;
  statusCode?: number;
}

/** The statement is repo-authored, so its length is bounded by the query. */
const STATEMENT_LIMIT = 400;

/**
 * A driver's `code` is its SQLSTATE (`42P01`), five characters of `[0-9A-Z]`.
 * Node's own connection errors use the same field for `ECONNREFUSED`, which is
 * not a state a statement can fail in — hence the shape check.
 */
const sqlStateOf = (cause: unknown): string | undefined => {
  const code = (cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[0-9A-Z]{5}$/u.test(code)
    ? code
    : undefined;
};

/** The endpoint without its query string: a provider key can ride there. */
const originOf = (url: string | undefined): string | undefined => {
  if (!url) {
    return;
  }

  try {
    return new URL(url).origin;
  } catch {
    // A relative or malformed URL: no origin to report, and nothing worth
    // guessing at.
  }
};

/**
 * The loggable shape of a chat failure.
 *
 * An `APICallError` carries `requestBodyValues` — the messages sent to the
 * model, which here include the reader's questions and their receipt text — and
 * a `url` that may carry a key in its query string. `console.error(error)`
 * prints both, and the log outlives the request, so the route records this
 * projection instead: which model, which endpoint, what the provider said, and
 * whether retrying could help. Nothing a reader typed.
 *
 * `onError` is not only called for provider failures: the AI SDK routes a
 * tool's own failure through it too, and there the message *is* the diagnosis
 * ("relation does not exist"). So the message is kept for errors the SDK did
 * not raise, and dropped for the ones it did — `TypeValidationError` prints the
 * value that failed (`Type validation failed: Value: {"query":"yogurt"}`), and
 * for a tool that value is its input.
 *
 * A chat tool's failures are usually database ones, and those are the case
 * where "keep the message" would leak on its own: drizzle wraps every failed
 * query in a `DrizzleQueryError` whose message is
 * `Failed query: <sql>\nparams: <bound values>`, and a search binds the
 * reader's words (`%yogurt%`). That error is projected down to its statement —
 * the SQL, with the placeholders still in it — plus the driver's SQLSTATE,
 * which says why it failed without quoting anything.
 */
export const chatFailureLog = (
  error: unknown,
  model: string
): ChatFailureLog => {
  const cause = unwrapRetries(error);
  const base = {
    code: chatErrorCode(error),
    model,
    name: error instanceof Error ? error.name : typeof error,
  };

  if (APICallError.isInstance(cause)) {
    return {
      ...base,
      isRetryable: cause.isRetryable,
      origin: originOf(cause.url),
      statusCode: cause.statusCode,
    };
  }

  // A failure inside a stream carries its status on the payload instead of the
  // wire, and has no URL to report.
  if (StreamProviderError.isInstance(cause)) {
    return {
      ...base,
      isRetryable: cause.isRetryable,
      ...(cause.statusCode === undefined
        ? {}
        : { statusCode: cause.statusCode }),
    };
  }

  if (AISDKError.isInstance(error) || AISDKError.isInstance(cause)) {
    return base;
  }

  if (error instanceof DrizzleQueryError) {
    const sqlState = sqlStateOf(error.cause);
    return {
      ...base,
      ...(sqlState ? { sqlState } : {}),
      statement: error.message
        .split("\n")[0]
        .replace(/^Failed query:\s*/u, "")
        .slice(0, STATEMENT_LIMIT),
    };
  }

  return error instanceof Error ? { ...base, message: error.message } : base;
};
