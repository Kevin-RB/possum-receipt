import { afterEach, describe, expect, it, vi } from "vitest";

import { CHAT_CATALOGUE } from "./catalogue";

/**
 * The catalogue is built from the deployment environment once at module load,
 * so each case imports a fresh copy with the key it is about. A registry built
 * per request would hide the bug these pin: a provider that resolves differently
 * from the one the picker last saw.
 *
 * `nodeEnv` defaults to `"test"` rather than inheriting the ambient value: a
 * shell or container that exports `NODE_ENV=development` would otherwise flip
 * every keyed case to the dev registry, failing assertions that describe a
 * deployment. A case that is about the gate passes `"development"` itself.
 */
const load = (apiKey: string, nodeEnv: "development" | "test" = "test") => {
  vi.resetModules();
  vi.stubEnv("OPENROUTER_API_KEY", apiKey);
  vi.stubEnv("NODE_ENV", nodeEnv);
  return import("./catalogue");
};

const REMOTE_MODELS = ["deepseek/deepseek-v4.1-flash-1017"];

const LOCAL_MODEL = "google/gemma-4-e4b";

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
      id: "openrouter/deepseek/deepseek-v4.1-flash-1017",
      selection: {
        model: "deepseek/deepseek-v4.1-flash-1017",
        provider: "openrouter",
      },
    });
  });

  it("registers local, and not openrouter, when no remote key resolves", async () => {
    const catalogue = await load("");

    expect(Object.keys(catalogue.chatProviders)).toStrictEqual(["local"]);
    expect(catalogue.resolveChatModel()).toMatchObject({
      id: "local/google/gemma-4-e4b",
      selection: { model: LOCAL_MODEL, provider: "local" },
    });
  });

  it("sends every OpenRouter request with tools required and ZDR preferred", async () => {
    const catalogue = await load("sk-test");

    const resolved = catalogue.resolveChatModel({
      model: "deepseek/deepseek-v4.1-flash-1017",
      provider: "openrouter",
    });

    expect(openRouterSettings(resolved?.model)).toStrictEqual({
      require_parameters: true,
      zdr: true,
    });
  });

  it("offers the picker the resolved entries, in catalogue order and nothing else", async () => {
    // The page hands this list to the picker, so it is the same resolution the
    // route validates against: the client never learns a model the route would
    // refuse, and its first row is the default.
    const catalogue = await load("sk-test");

    expect(catalogue.chatSelections()).toStrictEqual(
      REMOTE_MODELS.map((model) => ({ model, provider: "openrouter" }))
    );
    expect(catalogue.chatSelections()[0]).toStrictEqual(
      catalogue.resolveChatModel()?.selection
    );
  });

  it("offers only local when no remote key resolves", async () => {
    const catalogue = await load("");

    expect(catalogue.chatSelections()).toStrictEqual([
      { model: LOCAL_MODEL, provider: "local" },
    ]);
  });

  it("refuses a selection whose provider has no credential", async () => {
    const catalogue = await load("");

    expect(
      catalogue.resolveChatModel({
        model: "deepseek/deepseek-v4.1-flash-1017",
        provider: "openrouter",
      })
    ).toBeNull();
  });

  it("refuses a local selection when a remote key resolves outside development", async () => {
    const catalogue = await load("sk-test", "test");

    expect(
      catalogue.resolveChatModel({ model: LOCAL_MODEL, provider: "local" })
    ).toBeNull();
  });

  it("offers local beside the remote entry in development, remote still first", async () => {
    // The one case the default must not move: a development run with a key
    // starts on the remote model and can switch to local without unsetting the
    // key, which is what makes the two comparable in one sitting.
    const catalogue = await load("sk-test", "development");

    expect(Object.keys(catalogue.chatProviders)).toStrictEqual([
      "openrouter",
      "local",
    ]);
    expect(catalogue.chatSelections()).toStrictEqual([
      { model: REMOTE_MODELS[0], provider: "openrouter" },
      { model: LOCAL_MODEL, provider: "local" },
    ]);
    expect(catalogue.resolveChatModel()?.id).toBe(
      `openrouter/${REMOTE_MODELS[0]}`
    );
    expect(
      catalogue.resolveChatModel({ model: LOCAL_MODEL, provider: "local" })
    ).toMatchObject({
      id: `local/${LOCAL_MODEL}`,
      selection: { model: LOCAL_MODEL, provider: "local" },
    });
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

  it("resolves the local entry for the eval even where the picker would not offer it", async () => {
    // `pnpm eval:chat --local` measures a model a deployment deliberately does
    // not show, without unsetting the key first. The refusal above still holds:
    // the route asks `resolveChatModel`, and only the eval asks for this.
    const catalogue = await load("sk-test");

    expect(catalogue.chatSelections()).toStrictEqual([
      { model: REMOTE_MODELS[0], provider: "openrouter" },
    ]);
    expect(catalogue.resolveLocalChatModel()).toMatchObject({
      id: `local/${LOCAL_MODEL}`,
      selection: { model: LOCAL_MODEL, provider: "local" },
    });
    expect(
      catalogue.resolveChatModel({ model: LOCAL_MODEL, provider: "local" })
    ).toBeNull();
  });
});
