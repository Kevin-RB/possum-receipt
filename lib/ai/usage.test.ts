import { describe, expect, it } from "vitest";

import { formatCallCost, readCallCost } from "./usage";

describe(readCallCost, () => {
  it("reads the billed cost and the serving host from OpenRouter's metadata", () => {
    // The field the cost comes from: `providerMetadata.openrouter.usage.cost`,
    // which strict compatibility is what makes reportable. The model's
    // `pricing` object is never the answer — `zdr` excludes the endpoint it
    // prices (ADR-0022).
    const cost = readCallCost({
      openrouter: {
        provider: "Chutes",
        usage: { completionTokens: 412, cost: 0.000621, promptTokens: 1934 },
      },
    });

    expect(cost).toStrictEqual({
      costUsd: 0.000621,
      host: "Chutes",
      inputTokens: 1934,
      outputTokens: 412,
    });
  });

  it("reports nothing it was not given", () => {
    expect(readCallCost()).toStrictEqual({
      costUsd: null,
      host: null,
      inputTokens: null,
      outputTokens: null,
    });
  });

  it("ignores a usage block that is not an object", () => {
    expect(
      readCallCost({ openrouter: { provider: "Chutes", usage: "nope" } })
    ).toStrictEqual({
      costUsd: null,
      host: "Chutes",
      inputTokens: null,
      outputTokens: null,
    });
  });
});

describe(formatCallCost, () => {
  it("names the scope, the model, the host and the exact amount billed", () => {
    expect(
      formatCallCost("extraction", "deepseek/deepseek-v4.1-flash-1017", {
        costUsd: 0.000621,
        host: "Chutes",
        inputTokens: 1934,
        outputTokens: 412,
      })
    ).toBe(
      "[extraction] deepseek/deepseek-v4.1-flash-1017 host=Chutes cost=$0.000621 1934in/412out"
    );
  });

  it("says the cost is unknown rather than printing a fake one", () => {
    expect(
      formatCallCost("categorize", "some/model", {
        costUsd: null,
        host: null,
        inputTokens: null,
        outputTokens: null,
      })
    ).toBe("[categorize] some/model host=unknown cost=unknown ?in/?out");
  });
});
