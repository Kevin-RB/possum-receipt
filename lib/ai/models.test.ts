import { afterEach, describe, expect, it, vi } from "vitest";

const DEEPSEEK = "deepseek/deepseek-v4.1-flash-1017";

const importModels = () => import("./models");

const originalModel = process.env.EXTRACT_MODEL;

describe("extraction models", () => {
  afterEach(() => {
    if (originalModel === undefined) {
      delete process.env.EXTRACT_MODEL;
    } else {
      process.env.EXTRACT_MODEL = originalModel;
    }
    vi.resetModules();
  });

  it("defaults a first extraction to the dated DeepSeek revision", async () => {
    delete process.env.EXTRACT_MODEL;
    vi.resetModules();

    const { EXTRACT_MODEL, extractionSelections } = await importModels();

    expect(EXTRACT_MODEL).toBe(DEEPSEEK);
    expect(extractionSelections()).toStrictEqual([DEEPSEEK]);
  });

  it("defaults categorization to the extraction model", async () => {
    delete process.env.EXTRACT_MODEL;
    delete process.env.CATEGORIZE_MODEL;
    vi.resetModules();

    const { CATEGORIZE_MODEL, EXTRACT_MODEL } = await importModels();

    expect(CATEGORIZE_MODEL).toBe(EXTRACT_MODEL);
  });

  it("offers the configured model first, then the catalogue", async () => {
    process.env.EXTRACT_MODEL = "vendor/stronger-model";
    vi.resetModules();

    const { extractionSelections } = await importModels();

    expect(extractionSelections()).toStrictEqual([
      "vendor/stronger-model",
      DEEPSEEK,
    ]);
  });

  it("does not repeat a configured model the catalogue already holds", async () => {
    process.env.EXTRACT_MODEL = DEEPSEEK;
    vi.resetModules();

    const { extractionSelections } = await importModels();

    expect(extractionSelections()).toStrictEqual([DEEPSEEK]);
  });

  it("bounds a model id so a client cannot send an arbitrary string", async () => {
    delete process.env.EXTRACT_MODEL;
    vi.resetModules();

    const { extractionModelIdSchema } = await importModels();

    expect(extractionModelIdSchema.safeParse("").success).toBeFalsy();
    expect(
      extractionModelIdSchema.safeParse("a".repeat(201)).success
    ).toBeFalsy();
    expect(extractionModelIdSchema.safeParse(DEEPSEEK).success).toBeTruthy();
  });
});
