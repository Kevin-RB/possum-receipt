import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The catalogue builds its registry once at module load, so the provider has to
 * be mocked before the import for the constructor arguments to be observable.
 * `compatibility` is the one setting that never reaches `model.settings` — it
 * lives on the provider config — so it cannot be asserted through a resolved
 * model the way the routing flags are.
 */
const { createOpenRouter } = vi.hoisted(() => ({
  createOpenRouter: vi.fn<
    (options: { apiKey: string; compatibility: string }) => {
      chat: (model: string) => { modelId: string };
    }
  >(() => ({
    chat: vi.fn<(model: string) => { modelId: string }>(() => ({
      modelId: "mock-openrouter-model",
    })),
  })),
}));

// @ts-expect-error the mock is a partial provider; only `chat` is reached here
vi.mock(import("@openrouter/ai-sdk-provider"), () => ({ createOpenRouter }));

describe("openrouter provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds in strict mode, so a response carries token usage", async () => {
    // `compatible` (the package default) omits `stream_options.include_usage`,
    // which leaves OpenRouter never reporting what a question cost. `strict` is
    // the mode the provider's own types recommend for OpenRouter's API.
    vi.resetModules();
    vi.stubEnv("OPENROUTER_API_KEY", "sk-test");
    await import("./catalogue");

    expect(createOpenRouter).toHaveBeenCalledWith({
      apiKey: "sk-test",
      compatibility: "strict",
    });
  });
});
