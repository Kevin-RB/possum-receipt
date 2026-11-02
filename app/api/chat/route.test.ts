import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMEZONE } from "@/lib/time";

/**
 * The chat route's own link in the chain: the `cf-timezone` header, then the
 * page's `tz` cookie, then the browser's zone in the request body, then the
 * account's stored zone, then the constant. `lib/time.ts` and `lib/viewer.ts`
 * test the resolver in isolation; this pins the order the route actually passes
 * them in, which is the part a future edit could silently swap.
 */
const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  created: [] as { date: string; ownerId: string; timezone: string }[],
  header: undefined as string | undefined,
}));

// @ts-expect-error only `get` is reached; the rest of the store is unused here
vi.mock(import("next/headers"), () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "tz" && state.cookie ? { value: state.cookie } : undefined,
    }),
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "cf-timezone" ? (state.header ?? null) : null,
    }),
}));

const getSession = vi.hoisted(() =>
  vi.fn<
    () => Promise<{ user: { id: string; timezone: string | null } } | null>
  >()
);

// @ts-expect-error mock types don't need to match Better Auth internals
vi.mock(import("@/lib/auth"), () => ({
  auth: { api: { getSession } },
}));

// @ts-expect-error the stub only records the call; it is never streamed from
vi.mock(import("@/lib/chat/agent"), () => ({
  createChatAgent: (
    ownerId: string,
    today: Temporal.PlainDate,
    timezone: string
  ) => {
    state.created.push({ date: today.toString(), ownerId, timezone });
    return Promise.resolve({});
  },
}));

// @ts-expect-error the route only passes the tool set through to the SDK
vi.mock(import("@/lib/chat/tools"), () => ({ buildChatTools: () => ({}) }));
// @ts-expect-error the messages are already trusted in this test
vi.mock(import("@/lib/chat/trust"), () => ({
  discardUntrustedToolOutputs: (messages: unknown) => messages,
}));

// @ts-expect-error both are replaced by the smallest thing the route can run
vi.mock(import("ai"), () => ({
  createAgentUIStreamResponse: () => new Response("ok"),
  validateUIMessages: () => Promise.resolve([]),
}));

const { POST } = await import("./route");

/** The calendar date at this instant in a zone, read independently. */
const isoDayIn = (timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).format(new Date());

const post = async (body: Record<string, unknown>, accountZone?: string) => {
  state.created.length = 0;
  getSession.mockResolvedValue({
    user: { id: "owner-1", timezone: accountZone ?? null },
  });

  const request = new Request("http://localhost/api/chat", {
    body: JSON.stringify({ messages: [], ...body }),
    method: "POST",
  });

  await POST(request);
  return state.created[0];
};

describe("POST /api/chat resolves today", () => {
  beforeEach(() => {
    state.cookie = undefined;
    state.header = undefined;
  });

  it("asks the same sources the pages ask, in the same order", async () => {
    // The assistant and the charts must never disagree about which day it is,
    // so the chat walks the page chain rather than preferring the browser: the
    // edge, then the cookie it seeded, then the body.
    state.header = "Etc/GMT+12";
    state.cookie = "America/Bogota";

    const resolved = await post(
      { timezone: "Pacific/Kiritimati" },
      "Asia/Tokyo"
    );

    expect(resolved?.timezone).toBe("Etc/GMT+12");
    expect(resolved?.date).toBe(isoDayIn("Etc/GMT+12"));
  });

  it("uses the cookie when the request carries no header", async () => {
    state.cookie = "Etc/GMT+12";

    const resolved = await post(
      { timezone: "Pacific/Kiritimati" },
      "America/Bogota"
    );

    expect(resolved?.timezone).toBe("Etc/GMT+12");
    expect(resolved?.date).toBe(isoDayIn("Etc/GMT+12"));
  });

  it("uses the body's zone when neither the header nor a cookie exists", async () => {
    // The browser is still the best evidence a request has when nothing on the
    // wire carried a zone: local development, or a deployment whose edge header
    // went missing.
    const resolved = await post(
      { timezone: "Pacific/Kiritimati" },
      "America/Bogota"
    );

    expect(resolved?.timezone).toBe("Pacific/Kiritimati");
    expect(resolved?.date).toBe(isoDayIn("Pacific/Kiritimati"));
  });

  it("uses the account's zone when no transport carried one", async () => {
    const resolved = await post({}, "Etc/GMT+12");

    expect(resolved?.timezone).toBe("Etc/GMT+12");
    expect(resolved?.date).toBe(isoDayIn("Etc/GMT+12"));
  });

  it("falls back to the constant when nothing names a zone", async () => {
    state.cookie = undefined;

    const resolved = await post({});

    expect(resolved?.timezone).toBe(DEFAULT_TIMEZONE);
    expect(resolved?.date).toBe(isoDayIn(DEFAULT_TIMEZONE));
  });

  it("skips a body zone that is not a zone name", async () => {
    const resolved = await post({ timezone: "Not/AZone" }, "Etc/GMT+12");

    expect(resolved?.timezone).toBe("Etc/GMT+12");
  });

  it("rejects an unauthenticated request before resolving anything", async () => {
    state.created.length = 0;
    getSession.mockResolvedValue(null);

    const response = await POST(
      new Request("http://localhost/api/chat", {
        body: JSON.stringify({ messages: [] }),
        method: "POST",
      })
    );

    expect(response.status).toBe(401);
    expect(state.created).toHaveLength(0);
  });
});
