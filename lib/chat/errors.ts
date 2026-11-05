import { AISDKError, APICallError, RetryError } from "ai";

import { isUserMessage, USER_ERROR } from "@/lib/errors";

type ChatErrorCode = "generic" | "modelUnavailable";

/**
 * `maxRetries` (2 by default) reports the last failure inside a `RetryError`,
 * so the error the route receives is not the `APICallError` holding the cause.
 * Verified against `ai@7`: a model server that is down arrives as
 * `RetryError.lastError` → `APICallError` "Cannot connect to API: …".
 */
const unwrapRetries = (error: unknown): unknown =>
  RetryError.isInstance(error) ? unwrapRetries(error.lastError) : error;

/**
 * Every failed provider call — connection refused, a model the server does not
 * serve, a 5xx — means one thing to the person waiting: the assistant could
 * not answer. Those distinctions stay in the server log, where they are
 * actionable, rather than in the chat.
 */
export const chatErrorCode = (error: unknown): ChatErrorCode =>
  APICallError.isInstance(unwrapRetries(error))
    ? "modelUnavailable"
    : "generic";

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
   * Only for errors the AI SDK did not raise — a tool's DB or storage failure,
   * where the message is the diagnosis. See `chatFailureLog`.
   */
  message?: string;
  model: string;
  name: string;
  origin?: string;
  statusCode?: number;
}

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

  if (AISDKError.isInstance(error) || AISDKError.isInstance(cause)) {
    return base;
  }

  return error instanceof Error ? { ...base, message: error.message } : base;
};
