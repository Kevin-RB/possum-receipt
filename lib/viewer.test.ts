import { describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMEZONE } from "@/lib/time";

/**
 * The chain as the pages actually walk it: the zone the edge wrote into the
 * cookie, then the zone the account was created in, then the constant. Reading
 * the cookie is the only thing `next/headers` does here, so it is stubbed.
 */
const cookie = vi.hoisted(() => ({ value: undefined as string | undefined }));

// @ts-expect-error only `get` is reached; the rest of the cookie store is unused
vi.mock(import("next/headers"), () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "tz" && cookie.value ? { value: cookie.value } : undefined,
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

describe(viewerToday, () => {
  it("prefers the viewer's zone over the account's", async () => {
    // The bug this pins: the account's zone is where the reader signed up, so
    // answering from it tells a traveller the date they left behind.
    cookie.value = "Pacific/Kiritimati";

    await expect(todayIn("Pacific/Midway")).resolves.toBe(
      isoDayIn(Date.now(), "Pacific/Kiritimati")
    );
  });

  it("falls back to the account's zone when the edge reported none", async () => {
    cookie.value = undefined;

    await expect(todayIn("Pacific/Kiritimati")).resolves.toBe(
      isoDayIn(Date.now(), "Pacific/Kiritimati")
    );
  });

  it("falls back to the constant when neither names a zone", async () => {
    cookie.value = "Not/AZone";

    await expect(todayIn(null)).resolves.toBe(
      isoDayIn(Date.now(), DEFAULT_TIMEZONE)
    );
  });
});

describe(viewerTimezone, () => {
  it("reads the cookie the proxy writes from the edge header", async () => {
    cookie.value = "America/Bogota";

    await expect(viewerTimezone()).resolves.toBe("America/Bogota");
  });

  it("has no zone when the cookie is absent, as in local development", async () => {
    cookie.value = undefined;

    await expect(viewerTimezone()).resolves.toBeUndefined();
  });
});
