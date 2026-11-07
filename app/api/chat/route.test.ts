import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatAgentOptions } from "@/lib/chat/agent";
import type { ResolvedChatModel } from "@/lib/chat/catalogue";
import { USER_ERROR } from "@/lib/errors";
import { DEFAULT_TIMEZONE } from "@/lib/time";

/**
 * The chat route's own link in the chain: the `cf-timezone` header, then the
 * account's stored zone, then the constant. `lib/time.ts` and `lib/viewer.ts`
 * test the resolver in isolation; this pins the order the route passes them in,
 * which is the part a future edit could silently swap.
 *
 * The route takes nothing from the request body about the clock: a chat-only
 * candidate is how the assistant and the charts end up on different days.
 */
const state = vi.hoisted(() => ({
  created: [] as {
    date: string;
    model: unknown;
    ownerId: string;
    timezone: string;
  }[],
  header: undefined as string | undefined,
  model: {
    sentinel: "the resolved model",
  } as unknown as ResolvedChatModel["model"],
  tools: [] as { date: string; ownerId: string }[],
}));

const resolveChatModel = vi.hoisted(() =>
  vi.fn<(selection?: unknown) => ResolvedChatModel | null>()
);

// @ts-expect-error only `get` is reached; the rest of `Headers` is unused
vi.mock(import("next/headers"), () => ({
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
  createChatAgent: ({ model, ownerId, today, timezone }: ChatAgentOptions) => {
    state.created.push({
      date: today.toString(),
      model,
      ownerId,
      timezone,
    });
    return Promise.resolve({});
  },
}));

// The registry itself is covered by `lib/chat/catalogue.test.ts`; here the
// resolver is a stub so the route's validation and wiring are pinned without
// depending on whether the machine has a remote key.
vi.mock(import("@/lib/chat/catalogue"), () => ({ resolveChatModel }));

// @ts-expect-error the route only passes the tool set through to the SDK
vi.mock(import("@/lib/chat/tools"), () => ({
  buildChatTools: (ownerId: string, today: Temporal.PlainDate) => {
    state.tools.push({ date: today.toString(), ownerId });
    return {};
  },
}));
// @ts-expect-error the messages are already trusted in this test
vi.mock(import("@/lib/chat/trust"), () => ({
  discardUntrustedToolOutputs: (messages: unknown) => messages,
}));

vi.mock(import("ai"), () => ({
  createAgentUIStreamResponse: () => Promise.resolve(new Response("ok")),
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

const request = (body: Record<string, unknown>, accountZone?: string) => {
  getSession.mockResolvedValue({
    user: { id: "owner-1", timezone: accountZone ?? null },
  });

  return new Request("http://localhost/api/chat", {
    body: JSON.stringify({ messages: [], ...body }),
    method: "POST",
  });
};

const defaultResolved: ResolvedChatModel = {
  id: "openrouter/deepseek/deepseek-v4.1-flash",
  model: state.model,
  selection: {
    model: "deepseek/deepseek-v4.1-flash",
    provider: "openrouter",
  },
};

const post = async (body: Record<string, unknown>, accountZone?: string) => {
  state.created.length = 0;
  state.tools.length = 0;
  resolveChatModel.mockReset();
  resolveChatModel.mockReturnValue(defaultResolved);

  await POST(request(body, accountZone));
  return { ...state.created[0], tools: { ...state.tools[0] } };
};

describe("POST /api/chat resolves today", () => {
  beforeEach(() => {
    state.header = undefined;
  });

  it("uses the zone the edge put on the request", async () => {
    state.header = "Etc/GMT+12";

    const resolved = await post({}, "America/Bogota");

    expect(resolved?.timezone).toBe("Etc/GMT+12");
    expect(resolved?.date).toBe(isoDayIn("Etc/GMT+12"));
  });

  it("falls back to the account's zone when the edge reported none", async () => {
    const resolved = await post({}, "Etc/GMT+12");

    expect(resolved?.timezone).toBe("Etc/GMT+12");
    expect(resolved?.date).toBe(isoDayIn("Etc/GMT+12"));
  });

  it("falls back to the constant when nothing names a zone", async () => {
    const resolved = await post({});

    expect(resolved?.timezone).toBe(DEFAULT_TIMEZONE);
    expect(resolved?.date).toBe(isoDayIn(DEFAULT_TIMEZONE));
  });

  it("skips a header that is not a zone name", async () => {
    state.header = "Not/AZone";

    const resolved = await post({}, "Etc/GMT+12");

    expect(resolved?.timezone).toBe("Etc/GMT+12");
  });

  it("ignores a zone in the request body, so every surface reads one chain", async () => {
    // The client still sends it; the route must not use it. A chat-only
    // candidate is how the assistant ends up on a different day from the
    // charts, which is the bug this shape exists to prevent.
    state.header = "Etc/GMT+12";

    const resolved = await post({ timezone: "Pacific/Kiritimati" });

    expect(resolved?.timezone).toBe("Etc/GMT+12");
  });

  it("gives the tools the same today the prompt got", async () => {
    // The tools resolve a named period ("last_month") against this date. If they
    // were handed a second reading of the clock, a viewer whose day turned over
    // between the two calls would get a window that contradicts the prompt —
    // which is the whole reason the arithmetic moved server-side.
    state.header = "Etc/GMT+12";

    const resolved = await post({});

    expect(resolved.tools).toStrictEqual({
      date: resolved.date,
      ownerId: "owner-1",
    });
    // And that day is the viewer's, not the server's: the same zone the prompt
    // is told about is the one the period resolves in.
    expect(resolved.date).toBe(isoDayIn("Etc/GMT+12"));
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

describe("POST /api/chat resolves the catalogue selection", () => {
  beforeEach(() => {
    state.header = undefined;
  });

  it("takes the catalogue default when the body names no model", async () => {
    const resolved = await post({});

    expect(resolveChatModel).toHaveBeenCalledWith(undefined);
    expect(resolved.model).toBe(state.model);
  });

  it("passes the requested entry and nothing else to the resolver", async () => {
    // A client-supplied base URL is the SSRF path ADR-0017 refuses. Only the
    // two catalogue fields cross into the resolver; a credential or endpoint in
    // the body never does.
    const resolved = await post({
      baseURL: "http://internal.example/v1",
      model: "deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
    });

    expect(resolveChatModel).toHaveBeenCalledWith({
      model: "deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
    });
    expect(resolved.model).toBe(state.model);
  });

  it("refuses a selection the catalogue does not resolve before building an agent", async () => {
    resolveChatModel.mockReturnValue(null);
    state.created.length = 0;

    const response = await POST(
      request({
        model: "openai/gpt-9",
        provider: "openrouter",
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toStrictEqual({
      error: USER_ERROR.modelNotAvailable,
    });
    expect(state.created).toHaveLength(0);
  });
});
