import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMEZONE } from "@/lib/time";

/**
 * The chain as the pages actually walk it: the zone Cloudflare puts on the
 * request, then the copy `proxy.ts` keeps in the `tz` cookie, then the zone the
 * account was created in, then the constant. Both `next/headers` reads are
 * stubbed; everything below them is the real resolver.
 */
const edge = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  header: undefined as string | undefined,
}));

// @ts-expect-error only `get` is reached; the rest of the store is unused
vi.mock(import("next/headers"), () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "tz" && edge.cookie ? { value: edge.cookie } : undefined,
    }),
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "cf-timezone" ? (edge.header ?? null) : null,
    }),
}));

const { viewerTimezone, viewerToday } = await import("@/lib/viewer");

/** The calendar date at this instant in a zone, read independently. */
const isoDayIn = (instant: number, timezone: string) =>
  new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  }).format(new Date(instant));

const todayIn = async (accountZone?: string | null): Promise<string> => {
  const today = await viewerToday(accountZone);
  return today.toString();
};

describe(viewerTimezone, () => {
  beforeEach(() => {
    edge.header = undefined;
    edge.cookie = undefined;
  });

  it("reads the header the edge put on this request", async () => {
    // The header is per request, so it is right on the first render after
    // someone travels — before any cookie could have been rewritten.
    edge.header = "Pacific/Kiritimati";

    await expect(viewerTimezone()).resolves.toBe("Pacific/Kiritimati");
  });

  it("prefers the header over an older cookie", async () => {
    edge.header = "Pacific/Kiritimati";
    edge.cookie = "America/Bogota";

    await expect(viewerTimezone()).resolves.toBe("Pacific/Kiritimati");
  });

  it("uses the cookie when the request carries no header", async () => {
    // Local development has no Cloudflare, and neither does a LAN request.
    edge.cookie = "America/Bogota";

    await expect(viewerTimezone()).resolves.toBe("America/Bogota");
  });

  it("skips an empty header the way it skips an empty cookie", async () => {
    // Cloudflare can send the header with no value when it cannot place the IP.
    edge.header = "";
    edge.cookie = "America/Bogota";

    await expect(viewerTimezone()).resolves.toBe("America/Bogota");
  });

  it("has no zone when neither transport carried one", async () => {
    await expect(viewerTimezone()).resolves.toBeUndefined();
  });
});

describe(viewerToday, () => {
  beforeEach(() => {
    edge.header = undefined;
    edge.cookie = undefined;
  });

  it("prefers the viewer's zone over the account's", async () => {
    // The bug this pins: the account's zone is where the reader signed up, so
    // answering from it tells a traveller the date they left behind.
    edge.header = "Pacific/Kiritimati";

    await expect(todayIn("Etc/GMT+12")).resolves.toBe(
      isoDayIn(Date.now(), "Pacific/Kiritimati")
    );
  });

  it("falls back to the cookie when the header is absent", async () => {
    edge.cookie = "Pacific/Kiritimati";

    await expect(todayIn("Etc/GMT+12")).resolves.toBe(
      isoDayIn(Date.now(), "Pacific/Kiritimati")
    );
  });

  it("falls back to the account's zone when no transport carried one", async () => {
    await expect(todayIn("Pacific/Kiritimati")).resolves.toBe(
      isoDayIn(Date.now(), "Pacific/Kiritimati")
    );
  });

  it("falls back to the constant when nothing names a zone", async () => {
    edge.cookie = "Not/AZone";

    await expect(todayIn(null)).resolves.toBe(
      isoDayIn(Date.now(), DEFAULT_TIMEZONE)
    );
  });
});
