import {
  APICallError,
  RetryError,
  StreamProviderError,
  TypeValidationError,
} from "ai";
import { DrizzleQueryError } from "drizzle-orm";
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

/**
 * ADR-0014's map, walked row by row: every provider status lands in exactly one
 * bucket, so a new status cannot quietly inherit the wrong sentence.
 */
const statusCases: [number, string][] = [
  [408, "busy"],
  [409, "busy"],
  [429, "busy"],
  // 500/502/503/504 are the 5xx the ADR names; 501 and 599 are not, so they
  // pin "every 5xx" rather than a list of four.
  [500, "busy"],
  [501, "busy"],
  [502, "busy"],
  [503, "busy"],
  [504, "busy"],
  [599, "busy"],
  [401, "modelUnavailable"],
  [402, "modelUnavailable"],
  [403, "modelUnavailable"],
  [404, "modelUnavailable"],
  [200, "modelUnavailable"],
  [400, "generic"],
  [418, "generic"],
  [422, "generic"],
];

const withStatus = (statusCode: number) =>
  new APICallError({
    isRetryable: statusCode === 429,
    message: `provider said ${statusCode}`,
    requestBodyValues: {},
    statusCode,
    url: "https://openrouter.ai/api/v1/chat/completions",
  });

describe("chatErrorCode — the status map", () => {
  it.each(statusCases)("classifies %i as %s", (statusCode, expected) => {
    expect(chatErrorCode(withStatus(statusCode))).toBe(expected);
  });

  it("classifies a failure raised inside the stream by its own status", () => {
    expect(
      chatErrorCode(
        new StreamProviderError({
          message: "rate limited mid-stream",
          statusCode: 429,
        })
      )
    ).toBe("busy");

    expect(
      chatErrorCode(
        new StreamProviderError({
          message: "credits exhausted mid-stream",
          statusCode: 402,
        })
      )
    ).toBe("modelUnavailable");
  });

  it("sees a stream failure through the retry wrapper too", () => {
    expect(
      chatErrorCode(
        retriesExhausted(
          new StreamProviderError({ message: "down", statusCode: 503 })
        )
      )
    ).toBe("busy");
  });

  it("treats a stream failure with no status as unavailable", () => {
    expect(
      chatErrorCode(new StreamProviderError({ message: "no status" }))
    ).toBe("modelUnavailable");
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
      code: "busy",
      isRetryable: true,
      model: "gemma",
      origin: "http://127.0.0.1:1234",
      statusCode: 429,
    });
  });

  it("records a stream failure's status and retryability", () => {
    expect(
      chatFailureLog(
        new StreamProviderError({
          isRetryable: true,
          message: "out of credits",
          statusCode: 402,
        }),
        "gemma"
      )
    ).toStrictEqual({
      code: "modelUnavailable",
      isRetryable: true,
      model: "gemma",
      name: "AI_StreamProviderError",
      statusCode: 402,
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

  it("keeps a tool failure's message, which is the diagnosis", () => {
    // `onError` also receives what a tool threw, and a DB or storage failure is
    // diagnosed by its message. The app raised it, so it holds no reader text.
    expect(
      chatFailureLog(new Error('relation "receipts" does not exist'), "gemma")
    ).toStrictEqual({
      code: "generic",
      message: 'relation "receipts" does not exist',
      model: "gemma",
      name: "Error",
    });
  });

  it("logs a failed query's statement, never its bound values", () => {
    // The regression this pins: a chat tool's failure is usually a database
    // one, and drizzle's message is `Failed query: <sql>\nparams: <values>`.
    // For `search_line_items` those values are `%<what the reader typed>%`, so
    // keeping the message would put the search term back in `[chat]`.
    const logged = JSON.stringify(
      chatFailureLog(
        new DrizzleQueryError(
          'select "receipt_items"."name" from "receipt_items" where "receipt_items"."name" ilike $2',
          ["owner-1", "%yogurt%"],
          Object.assign(new Error('relation "receipt_items" does not exist'), {
            code: "42P01",
          })
        ),
        "gemma"
      )
    );

    expect(logged).not.toContain("yogurt");
    expect(JSON.parse(logged)).toStrictEqual({
      code: "generic",
      model: "gemma",
      name: "DrizzleQueryError",
      sqlState: "42P01",
      statement:
        'select "receipt_items"."name" from "receipt_items" where "receipt_items"."name" ilike $2',
    });
  });

  it("omits a code that is not a SQLSTATE", () => {
    // Node reports a dead connection with the same field, as `ECONNREFUSED`.
    // Reporting it as a statement's state would be wrong, so the shape decides.
    expect(
      chatFailureLog(
        new DrizzleQueryError(
          "select 1",
          [],
          Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          })
        ),
        "gemma"
      )
    ).toStrictEqual({
      code: "generic",
      model: "gemma",
      name: "DrizzleQueryError",
      statement: "select 1",
    });
  });

  it("drops the message of an AI SDK error, which can print what failed", () => {
    // `TypeValidationError` renders its value into the message, and for a tool
    // that value is the model's arguments — here a search term the reader
    // typed. This is why a blanket "keep the message" is not the rule.
    const logged = JSON.stringify(
      chatFailureLog(
        new TypeValidationError({
          cause: new Error("bad"),
          value: { query: "yogurt" },
        }),
        "gemma"
      )
    );

    expect(logged).not.toContain("yogurt");
    expect(JSON.parse(logged)).toStrictEqual({
      code: "generic",
      model: "gemma",
      name: "AI_TypeValidationError",
    });
  });

  it("describes something that was not an error at all", () => {
    expect(chatFailureLog("boom", "gemma")).toStrictEqual({
      code: "generic",
      model: "gemma",
      name: "string",
    });
  });
});
