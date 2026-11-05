import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { USER_ERROR } from "@/lib/errors";

import { chatErrorCode, chatErrorText, chatFailureLog } from "./errors";

/**
 * The shape `@ai-sdk/openai-compatible` produces when LM Studio is not
 * listening: a native fetch failure with no response, so no status code.
 */
const connectionFailed = () =>
  new APICallError({
    isRetryable: true,
    message: "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:1234",
    requestBodyValues: {},
    url: "http://127.0.0.1:1234/v1/chat/completions",
  });

/** A rate-limited provider call, with a key in the URL and a body to leak. */
const providerError = () =>
  new APICallError({
    isRetryable: true,
    message: "429 Too Many Requests",
    requestBodyValues: { messages: [{ content: "Did I buy yogurt?" }] },
    statusCode: 429,
    url: "http://127.0.0.1:1234/v1/chat/completions?key=sk-secret",
  });

const retriesExhausted = (lastError: unknown) =>
  new RetryError({
    errors: [lastError, lastError, lastError],
    message:
      "Failed after 3 attempts. Last error: AI_APICallError: Cannot connect to API",
    reason: "maxRetriesExceeded",
  });

describe(chatErrorCode, () => {
  it("reports an unreachable model server as unavailable", () => {
    expect(chatErrorCode(connectionFailed())).toBe("modelUnavailable");
  });

  it("sees through the retry wrapper to the failed call", () => {
    expect(chatErrorCode(retriesExhausted(connectionFailed()))).toBe(
      "modelUnavailable"
    );
  });

  it("falls back to generic wording for anything else", () => {
    expect(chatErrorCode(new Error("relation does not exist"))).toBe("generic");
    expect(chatErrorCode("a string, not an error")).toBe("generic");
  });
});

describe(chatErrorText, () => {
  it("shows the wording the route wrote", () => {
    expect(chatErrorText(new Error(USER_ERROR.modelUnavailable))).toBe(
      USER_ERROR.modelUnavailable
    );
  });

  it("replaces a response body with the generic line", () => {
    expect(chatErrorText(new Error('{"error":"Unauthorized"}'))).toBe(
      USER_ERROR.generic
    );
    expect(
      chatErrorText(new Error("Failed after 3 attempts. Last error: …"))
    ).toBe(USER_ERROR.generic);
  });

  it("names an expired session when the request was refused", () => {
    expect(
      chatErrorText(
        new APICallError({
          message: '{"error":"Unauthorized"}',
          requestBodyValues: {},
          statusCode: 401,
          url: "http://localhost:3000/api/chat",
        })
      )
    ).toBe(USER_ERROR.unauthorized);
  });
});

describe(chatFailureLog, () => {
  it("keeps what makes a failure actionable", () => {
    expect(chatFailureLog(providerError(), "gemma")).toMatchObject({
      code: "modelUnavailable",
      isRetryable: true,
      model: "gemma",
      origin: "http://127.0.0.1:1234",
      statusCode: 429,
    });
  });

  it("never records what the reader typed", () => {
    // The regression this pins: `reportError` stringifies the error, and an
    // APICallError carries the whole request body — the question, and with it
    // the receipt text the question quotes.
    const logged = JSON.stringify(chatFailureLog(providerError(), "gemma"));

    expect(logged).not.toContain("yogurt");
    expect(logged).not.toContain("messages");
    expect(logged).not.toContain("requestBody");
  });

  it("reports the endpoint without the query string a key can ride in", () => {
    expect(
      JSON.stringify(chatFailureLog(providerError(), "gemma"))
    ).not.toContain("sk-secret");
  });

  it("unwraps a retry chain to the provider failure underneath", () => {
    expect(
      chatFailureLog(retriesExhausted(providerError()), "gemma")
    ).toMatchObject({ statusCode: 429 });
  });

  it("describes an error that never reached a provider at all", () => {
    expect(chatFailureLog(new TypeError("boom"), "gemma")).toStrictEqual({
      code: "generic",
      model: "gemma",
      name: "TypeError",
    });
  });
});
