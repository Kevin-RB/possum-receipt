import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildChatTools } from "./tools/index";
import { spendByCategoryInput } from "./tools/spend-by-category";

const mocks = vi.hoisted(() => ({
  listReceiptSummaries: vi.fn<() => Promise<unknown>>(),
  receiptDetail: vi.fn<() => Promise<unknown>>(),
  searchLineItems: vi.fn<() => Promise<unknown>>(),
  spendByCategory: vi.fn<() => Promise<unknown>>(),
  spendByMerchant: vi.fn<() => Promise<unknown>>(),
}));

// The queries hit Postgres, so they are stubbed. Only the arguments matter
// here — these tests assert on owner scoping, not on results.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- `vi.mock` cannot preserve per-function generics
vi.mock(import("./queries"), () => mocks as any);

const OWNER = "user-1";

/**
 * The viewer's day, pinned: the tools resolve a named period against the date
 * the caller hands in, so the same expectations hold whenever the suite runs.
 * 2026-11-04 is a Wednesday.
 */
const TODAY = Temporal.PlainDate.from("2026-11-04");

/**
 * The read tools close over `ownerId` server-side. These tests pin that: the
 * model never supplies an owner, so if a tool ever took one as an argument, a
 * prompt injection hidden in a receipt transcript could reach another user's
 * data.
 *
 * They also pin the other half of the same seam: the model names a period and
 * the tool resolves it against `today`, so no ISO date the model produced can
 * reach a query.
 */
describe("owner scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("binds the owner into list_receipts and resolves a named period", async () => {
    await buildChatTools(OWNER, TODAY).list_receipts.execute?.(
      { merchant: "Woolworths", range: "last_month" },
      {} as never
    );

    expect(mocks.listReceiptSummaries).toHaveBeenCalledWith(OWNER, {
      from: "2026-10-01",
      merchant: "Woolworths",
      to: "2026-10-31",
    });
  });

  it("binds the owner into search_line_items", async () => {
    await buildChatTools(OWNER, TODAY).search_line_items.execute?.(
      { query: "cheese" },
      {} as never
    );

    expect(mocks.searchLineItems).toHaveBeenCalledWith(OWNER, {
      query: "cheese",
    });
  });

  it("passes explicit dates through when the user named them", async () => {
    await buildChatTools(OWNER, TODAY).search_line_items.execute?.(
      { from: "2026-03-03", query: "cheese", to: "2026-03-09" },
      {} as never
    );

    expect(mocks.searchLineItems).toHaveBeenCalledWith(OWNER, {
      from: "2026-03-03",
      query: "cheese",
      to: "2026-03-09",
    });
  });

  it("prefers a named range over dates the model also supplied", async () => {
    await buildChatTools(OWNER, TODAY).spend_by_merchant.execute?.(
      { from: "2026-01-01", range: "today", to: "2026-01-31" },
      {} as never
    );

    expect(mocks.spendByMerchant).toHaveBeenCalledWith(OWNER, {
      from: "2026-11-04",
      to: "2026-11-04",
    });
  });

  it("sends no bounds at all when no period was given", async () => {
    await buildChatTools(OWNER, TODAY).spend_by_merchant.execute?.(
      {},
      {} as never
    );

    expect(mocks.spendByMerchant).toHaveBeenCalledWith(OWNER, {});
  });

  it("passes the category grouping through to the query", async () => {
    await buildChatTools(OWNER, TODAY).spend_by_category.execute?.(
      { groupBy: "category", range: "this_year" },
      {} as never
    );

    expect(mocks.spendByCategory).toHaveBeenCalledWith(OWNER, {
      category: undefined,
      from: "2026-01-01",
      groupBy: "category",
      to: "2026-11-04",
    });
  });

  it("passes a single-category filter through to the query", async () => {
    await buildChatTools(OWNER, TODAY).spend_by_category.execute?.(
      { category: "Health", range: "last_month" },
      {} as never
    );

    expect(mocks.spendByCategory).toHaveBeenCalledWith(OWNER, {
      category: "Health",
      from: "2026-10-01",
      groupBy: undefined,
      to: "2026-10-31",
    });
  });

  it("accepts only the two known category groupings and the known ranges", () => {
    expect(
      spendByCategoryInput.parse({
        category: "Health",
        groupBy: "category",
        range: "last_month",
      })
    ).toStrictEqual({
      category: "Health",
      groupBy: "category",
      range: "last_month",
    });
    expect(
      spendByCategoryInput.safeParse({ groupBy: "leaf" }).success
    ).toBeFalsy();
    expect(
      spendByCategoryInput.safeParse({ range: "the_last_2_months" }).success
    ).toBeFalsy();
    expect(spendByCategoryInput.safeParse({}).success).toBeTruthy();
  });

  it("does not accept an owner argument on any tool", () => {
    for (const [name, tool] of Object.entries(buildChatTools(OWNER, TODAY))) {
      const properties = Object.keys(
        (tool.inputSchema as { shape?: object }).shape ?? {}
      );
      expect(properties, `${name} input`).not.toContain("ownerId");
      expect(properties, `${name} input`).not.toContain("userId");
    }
  });
});

describe("tool/UI coverage", () => {
  // Renaming a tool is a deliberate edit here rather than a silent change in
  // what the model can call. A tool added without a `case` in
  // `chat-message.tsx` is already a build error — see `unreachableToolPart`.
  it("exposes exactly the six agreed tools", () => {
    expect(Object.keys(buildChatTools(OWNER, TODAY)).toSorted()).toStrictEqual([
      "ask_user",
      "list_receipts",
      "receipt_detail",
      "search_line_items",
      "spend_by_category",
      "spend_by_merchant",
    ]);
  });

  it("declares an input and output schema for every tool", () => {
    for (const [name, tool] of Object.entries(buildChatTools(OWNER, TODAY))) {
      expect(tool.inputSchema, `${name} inputSchema`).toBeDefined();
      expect(tool.outputSchema, `${name} outputSchema`).toBeDefined();
    }
  });

  it("leaves ask_user for the client to complete", () => {
    // No `execute` is the whole mechanism: the UI supplies the output via
    // `addToolOutput`, so defining one would make the tool server-only and
    // break the `sendAutomaticallyWhen` resume path.
    expect(buildChatTools(OWNER, TODAY).ask_user.execute).toBeUndefined();
  });

  it("renders every tool in agent-steps.tsx", () => {
    // `AgentStep`'s `default` branch passes the unhandled part to a
    // `never` parameter, so TypeScript already rejects a missing case. This
    // asserts the same pairing at runtime, which also catches a `case` whose
    // label has drifted from the tool set.
    const source = readFileSync(
      new URL("../../components/chat/agent-steps.tsx", import.meta.url),
      "utf-8"
    );
    const names = [...source.matchAll(/case "tool-(?<name>[a-z_]+)":/gu)].map(
      (match) => match.groups?.name ?? ""
    );

    expect(names.toSorted()).toStrictEqual(
      Object.keys(buildChatTools(OWNER, TODAY)).toSorted()
    );
  });
});
