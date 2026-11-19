import { NoObjectGeneratedError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  EXTRACTION_PROMPT,
  FAILED_TRANSCRIPT_LIMIT,
  extractReceipt,
  TranscriptExtractionSchema,
} from "./extract-receipt";

const { mockModel } = vi.hoisted(() => ({
  mockModel: vi.fn<(model: string, scope: string) => MockLanguageModelV4>(),
}));

vi.mock(import("./provider"), () => ({
  extractionModel: mockModel,
  openRouterConfigured: () => true,
}));

const mockResult = (text: string) => ({
  content: [{ text, type: "text" as const }],
  finishReason: { raw: undefined, unified: "stop" as const },
  usage: {
    inputTokens: {
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: 1,
      total: 1,
    },
    outputTokens: { reasoning: undefined, text: 1, total: 1 },
  },
  warnings: [],
});

const validExtraction = {
  items: [{ kind: "product", lineTotal: 10, name: "Product", quantity: 1 }],
  merchant: { name: "Test Cafe" },
  payment: { method: "card" },
  totals: { total: 10 },
  transaction: {},
};

const validResponse = JSON.stringify({
  transcript: "MILK 10.00\nTOTAL 10.00",
  ...validExtraction,
});

const modelFor = (text: string) => {
  const model = new MockLanguageModelV4({ doGenerate: mockResult(text) });
  mockModel.mockReturnValue(model);
  return model;
};

/** The prompt as the model sees it: raw text parts joined, unescaped. */
const renderPromptText = (model: MockLanguageModelV4) => {
  const messages = (model.doGenerateCalls.at(0)?.prompt ?? []) as unknown as {
    content?: unknown[];
  }[];
  return messages
    .flatMap((message) => message.content ?? [])
    .flatMap((part: unknown) =>
      part && typeof part === "object" && "text" in part
        ? [String((part as { text: unknown }).text)]
        : []
    )
    .join("\n");
};

const renderPromptJson = (model: MockLanguageModelV4) =>
  JSON.stringify(model.doGenerateCalls.at(0)?.prompt ?? null);

const extract = () =>
  extractReceipt({ base64: "aGVsbG8=", mediaType: "image/jpeg" });

describe(extractReceipt, () => {
  beforeEach(() => {
    mockModel.mockReset();
  });

  it("returns the extraction and the transcript as separate values", async () => {
    modelFor(validResponse);

    const attempt = await extract();

    expect(attempt).toStrictEqual({
      extraction: validExtraction,
      ok: true,
      transcript: "MILK 10.00\nTOTAL 10.00",
    });
  });

  it("keeps the transcript out of the extraction the receipt is stored from", async () => {
    modelFor(validResponse);

    const attempt = await extract();

    expect(attempt.ok && "transcript" in attempt.extraction).toBeFalsy();
  });

  it("declares the transcript as the first field of the model-facing schema", () => {
    // The model writes what it read before it writes any field, which is the
    // whole reason the field exists (ADR-0022).
    expect(Object.keys(TranscriptExtractionSchema.shape)).toStrictEqual([
      "transcript",
      "merchant",
      "payment",
      "totals",
      "transaction",
      "items",
    ]);
  });

  it("asks the model to transcribe before it extracts, and sends the image", async () => {
    const model = modelFor(validResponse);

    await extract();

    const prompt = renderPromptText(model);
    expect(prompt).toContain(EXTRACTION_PROMPT);
    expect(prompt).toContain("before you extract any other field");

    const serialised = renderPromptJson(model);
    expect(serialised).toContain("aGVsbG8=");
    expect(serialised).toContain("image/jpeg");
  });

  it("runs one multimodal call, at temperature zero", async () => {
    const model = modelFor(validResponse);

    await extract();

    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0].temperature).toBe(0);
  });

  it("asks the provider for a JSON response shaped like the transcript schema", async () => {
    const model = modelFor(validResponse);

    await extract();

    const format = model.doGenerateCalls[0].responseFormat;
    expect(format?.type).toBe("json");
    expect(
      format?.type === "json"
        ? Object.keys(format.schema?.properties ?? {})
        : []
    ).toStrictEqual([
      "transcript",
      "merchant",
      "payment",
      "totals",
      "transaction",
      "items",
    ]);
  });

  it("applies the contract's defaults to a line the model left sparse", async () => {
    modelFor(
      JSON.stringify({
        ...validExtraction,
        items: [{ lineTotal: 10, name: "Product" }],
        transcript: "PRODUCT 10.00",
      })
    );

    const attempt = await extract();

    expect(attempt.ok && attempt.extraction.items[0].kind).toBe("product");
    expect(attempt.ok && attempt.extraction.items[0].quantity).toBe(1);
  });

  it("uses the configured model unless one is named", async () => {
    modelFor(validResponse);

    await extract();
    expect(mockModel).toHaveBeenLastCalledWith(
      "deepseek/deepseek-v4.1-flash-1017",
      "extraction"
    );

    await extractReceipt({
      base64: "aGVsbG8=",
      mediaType: "image/jpeg",
      model: "another/model",
    });
    expect(mockModel).toHaveBeenLastCalledWith("another/model", "extraction");
  });

  it("keeps the raw text when the response is not JSON", async () => {
    modelFor("definitely not json");

    const attempt = await extract();

    expect(attempt.ok).toBeFalsy();
    expect(attempt.ok === false ? attempt.rawText : null).toBe(
      "definitely not json"
    );
  });

  it("keeps the raw text when the response does not satisfy the contract", async () => {
    const partial = JSON.stringify({ totals: { total: 10 } });
    modelFor(partial);

    const attempt = await extract();

    expect(attempt.ok).toBeFalsy();
    expect(attempt.ok === false ? attempt.rawText : null).toBe(partial);
  });

  it("reports the schema failure rather than throwing it", async () => {
    modelFor("{}");

    const attempt = await extract();

    expect(attempt.ok).toBeFalsy();
    expect(attempt.ok === false && attempt.reason).toMatch(
      /did not match|parse|JSON/iu
    );
  });

  it("truncates a runaway response instead of storing all of it", async () => {
    modelFor("x".repeat(FAILED_TRANSCRIPT_LIMIT + 5000));

    const attempt = await extract();

    expect(attempt.ok === false ? attempt.rawText?.length : null).toBe(
      FAILED_TRANSCRIPT_LIMIT
    );
  });

  it("has nothing to keep when the failure carries no text", async () => {
    modelFor("");
    mockModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: () => {
          throw new NoObjectGeneratedError({
            cause: new Error("no text"),
            finishReason: "stop",
            message: "no text",
            response: {
              body: undefined,
              id: "id",
              modelId: "deepseek/deepseek-v4.1-flash-1017",
              timestamp: new Date(),
            },
            text: undefined,
            usage: {
              inputTokenDetails: {
                cacheReadTokens: undefined,
                cacheWriteTokens: undefined,
                noCacheTokens: undefined,
              },
              inputTokens: 1,
              outputTokenDetails: {
                reasoningTokens: undefined,
                textTokens: undefined,
              },
              outputTokens: 0,
              totalTokens: 1,
            },
          });
        },
      })
    );

    const attempt = await extract();

    expect(attempt).toStrictEqual({
      ok: false,
      rawText: null,
      reason: "no text",
    });
  });

  it("lets a provider failure through, so the run's retry policy sees it", async () => {
    mockModel.mockReturnValue(
      new MockLanguageModelV4({
        doGenerate: () => {
          throw new Error("provider exploded");
        },
      })
    );

    await expect(extract()).rejects.toThrow("provider exploded");
  });
});
