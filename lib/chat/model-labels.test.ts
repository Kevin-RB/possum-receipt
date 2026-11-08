import { describe, expect, it } from "vitest";

import { modelGroups, modelLabel, selectionKey } from "./model-labels";

const deepseek = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  provider: "openrouter",
} as const;

const glm = {
  model: "z-ai/glm-5.3-flash",
  provider: "openrouter",
} as const;

const local = { model: "google/gemma-4-e4b", provider: "local" } as const;

describe("model label", () => {
  it("drops the author segment, which the provider heading already gives", () => {
    expect(modelLabel(deepseek)).toBe("deepseek-v4.1-flash-1017");
    expect(modelLabel(glm)).toBe("glm-5.3-flash");
  });

  it("wraps the local model, so a reader knows the request stays here", () => {
    expect(modelLabel(local)).toBe("local (gemma-4-e4b)");
  });

  it("leaves an id with no author segment alone", () => {
    expect(modelLabel({ model: "gemma-4-e4b", provider: "local" })).toBe(
      "local (gemma-4-e4b)"
    );
  });

  it("never shows the composed key", () => {
    expect(modelLabel(deepseek)).not.toContain("openrouter");
    expect(modelLabel(deepseek)).not.toContain("/");
    expect(selectionKey(deepseek)).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash-1017"
    );
  });
});

describe("model groups", () => {
  it("groups under a heading per provider, in catalogue order", () => {
    expect(modelGroups([deepseek, glm, local])).toStrictEqual([
      {
        heading: "OpenRouter",
        provider: "openrouter",
        selections: [deepseek, glm],
      },
      { heading: "Local", provider: "local", selections: [local] },
    ]);
  });

  it("returns one group when one provider resolves, so the list is flat", () => {
    const groups = modelGroups([local]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.selections).toStrictEqual([local]);
  });
});
