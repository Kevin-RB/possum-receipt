import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_CATALOGUE } from "./catalogue";

/**
 * The catalogue is built from the deployment environment once at module load,
 * so each case imports a fresh copy with the key it is about. A registry built
 * per request would hide the bug these pin: a provider that resolves differently
 * from the one the picker last saw.
 */
const load = (apiKey: string) => {
  vi.resetModules();
  vi.stubEnv("OPENROUTER_API_KEY", apiKey);
  return import("./catalogue");
};

const REMOTE_MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "anthropic/claude-haiku-5.5",
  "z-ai/glm-5.3-flash",
  "qwen/qwen3.8-27b",
  "google/gemini-3.5-flash-lite",
];

const LOCAL_MODEL = "gemma-4-e4b";

const openRouterSettings = (model: unknown) =>
  (model as { settings?: { provider?: Record<string, unknown> } }).settings
    ?.provider;

describe("chat catalogue", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("orders the remote entries by input price, with local last as the fallback", () => {
    const remote = CHAT_CATALOGUE.filter(
      (entry) => entry.provider === "openrouter"
    );
    const inputs = remote.map((entry) => entry.price?.input);

    expect(remote.map((entry) => entry.model)).toStrictEqual(REMOTE_MODELS);
    expect(inputs).toStrictEqual(
      inputs.toSorted((a, b) => (a ?? 0) - (b ?? 0))
    );
    expect(CHAT_CATALOGUE.at(-1)).toStrictEqual({
      model: LOCAL_MODEL,
      price: null,
      provider: "local",
    });
  });

  it("registers openrouter, and not local, when a remote key resolves", async () => {
    const catalogue = await load("sk-test");

    expect(Object.keys(catalogue.chatProviders)).toStrictEqual(["openrouter"]);
    expect(catalogue.resolveChatModel()).toMatchObject({
      id: "openrouter/deepseek/deepseek-v4.1-flash",
      selection: {
        model: "deepseek/deepseek-v4.1-flash",
        provider: "openrouter",
      },
    });
  });

  it("registers local, and not openrouter, when no remote key resolves", async () => {
    const catalogue = await load("");

    expect(Object.keys(catalogue.chatProviders)).toStrictEqual(["local"]);
    expect(catalogue.resolveChatModel()).toMatchObject({
      id: "local/gemma-4-e4b",
      selection: { model: LOCAL_MODEL, provider: "local" },
    });
  });

  it("sends every OpenRouter request with tools required and ZDR preferred", async () => {
    const catalogue = await load("sk-test");

    const resolved = catalogue.resolveChatModel({
      model: "deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
    });

    expect(openRouterSettings(resolved?.model)).toStrictEqual({
      require_parameters: true,
      zdr: true,
    });
  });

  it("refuses a selection whose provider has no credential", async () => {
    const catalogue = await load("");

    expect(
      catalogue.resolveChatModel({
        model: "deepseek/deepseek-v4.1-flash",
        provider: "openrouter",
      })
    ).toBeNull();
  });

  it("refuses a local selection when a remote key resolves, since local is absent", async () => {
    const catalogue = await load("sk-test");

    expect(
      catalogue.resolveChatModel({ model: LOCAL_MODEL, provider: "local" })
    ).toBeNull();
  });

  it("refuses an unknown model, an unknown provider and a malformed selection", async () => {
    const catalogue = await load("sk-test");

    expect(
      catalogue.resolveChatModel({
        model: "openai/gpt-9",
        provider: "openrouter",
      })
    ).toBeNull();
    expect(
      catalogue.resolveChatModel({ model: REMOTE_MODELS[0], provider: "nope" })
    ).toBeNull();
    expect(catalogue.resolveChatModel({ provider: "openrouter" })).toBeNull();
    expect(catalogue.resolveChatModel("openrouter")).toBeNull();
  });
});
