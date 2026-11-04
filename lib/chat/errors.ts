import { APICallError, RetryError } from "ai";

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
