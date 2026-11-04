import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { USER_ERROR } from "@/lib/errors";

import { chatErrorCode, chatErrorText } from "./errors";

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
