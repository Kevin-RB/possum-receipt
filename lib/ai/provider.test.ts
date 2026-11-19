import { APICallError, RetryError } from "ai";
import { describe, expect, it } from "vitest";

import { isRetryableProviderFailure } from "./provider";

const apiError = (isRetryable: boolean, statusCode?: number) =>
  new APICallError({
    isRetryable,
    message: `provider said ${statusCode ?? "nothing"}`,
    requestBodyValues: {},
    url: "https://openrouter.ai/api/v1/chat/completions",
    ...(statusCode === undefined ? {} : { statusCode }),
  });

const retried = (lastError: unknown) =>
  new RetryError({
    errors: [lastError],
    message: "Failed after 2 attempts.",
    reason: "maxRetriesExceeded",
  });

describe(isRetryableProviderFailure, () => {
  it("retries the failure the SDK wrapped, not the wrapper", () => {
    // `generateText` reports its last failure inside a `RetryError`, so a
    // rate limit arrives as a `RetryError` whose `lastError` is the
    // `APICallError` that knows it is retryable. ADR-0022 relies on Inngest
    // retrying exactly these.
    expect(
      isRetryableProviderFailure(retried(apiError(true, 429)))
    ).toBeTruthy();
    expect(
      isRetryableProviderFailure(retried(apiError(true, 503)))
    ).toBeTruthy();
  });

  it("does not retry a request the provider refused", () => {
    expect(
      isRetryableProviderFailure(retried(apiError(false, 400)))
    ).toBeFalsy();
    expect(isRetryableProviderFailure(apiError(false, 401))).toBeFalsy();
  });

  it("reads a bare provider failure too", () => {
    expect(isRetryableProviderFailure(apiError(true, 500))).toBeTruthy();
  });

  it("does not retry a failure that is not the provider's", () => {
    // A schema failure is returned by `extractReceipt`, not thrown, and a bug
    // is not a transient condition: neither should circle through Inngest.
    expect(isRetryableProviderFailure(new Error("boom"))).toBeFalsy();
    expect(isRetryableProviderFailure(retried(new Error("boom")))).toBeFalsy();
    expect(isRetryableProviderFailure()).toBeFalsy();
  });
});
