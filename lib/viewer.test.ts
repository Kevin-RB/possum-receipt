import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_TIMEZONE } from "@/lib/time";

/**
 * The chain as every surface walks it: the zone Cloudflare puts on the request,
 * then the zone the account was created in, then the constant. One chain, one
 * order — the assistant and the charts read the same function, so they cannot
 * disagree about the day.
 *
 * `next/headers` is stubbed; everything below it is the real resolver.
 */
const request = vi.hoisted(() => ({ header: undefined as string | undefined }));

// @ts-expect-error only `get` is reached; the rest of `Headers` is unused
vi.mock(import("next/headers"), () => ({
  headers: () =>
    Promise.resolve({
      get: (name: string) =>
        name === "cf-timezone" ? (request.header ?? null) : null,
    }),
}));

const { viewerTimezone, viewerToday, viewerZone } =
  await import("@/lib/viewer");

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
    request.header = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("reads the header the edge put on this request", async () => {
    // The header is per request, so it is right on the first render after
    // someone travels — nothing has to be written first.
    request.header = "Pacific/Kiritimati";

    await expect(viewerTimezone()).resolves.toBe("Pacific/Kiritimati");
  });

  it("has no zone when the header is absent, as in local development", async () => {
    await expect(viewerTimezone()).resolves.toBeUndefined();
  });

  it("stands in for the edge when development was told a zone", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TIMEZONE", "America/Bogota");

    await expect(viewerTimezone()).resolves.toBe("America/Bogota");
  });

  it("ignores the stand-in outside development", async () => {
    // A deployment is built with NODE_ENV=production and a client cannot set an
    // environment variable, so the stand-in exists only on a dev machine.
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_TIMEZONE", "America/Bogota");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(viewerTimezone()).resolves.toBeUndefined();
  });

  it("ignores a stand-in that does not name a zone", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TIMEZONE", "Not/AZone");

    await expect(viewerTimezone()).resolves.toBeUndefined();
  });

  it("says so in production when the edge reported nothing", async () => {
    // Pages then answer from the account, which is invisible unless someone
    // looks for it — the one place to make that visible is the log. The warning
    // is once per process, so this needs its own module instance.
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fresh = await import("@/lib/viewer");

    await fresh.viewerTimezone();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("no cf-timezone header")
    );
  });

  it("stays quiet when the header is there", async () => {
    vi.stubEnv("NODE_ENV", "production");
    request.header = "America/Bogota";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await viewerTimezone();

    expect(warn).not.toHaveBeenCalled();
  });
});

describe(viewerZone, () => {
  beforeEach(() => {
    request.header = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves the chain once, for anything in the render that needs a zone", async () => {
    request.header = "Pacific/Kiritimati";

    await expect(viewerZone("Etc/GMT+12")).resolves.toBe("Pacific/Kiritimati");
  });

  it("never returns undefined, so callers cannot fall back on their own", async () => {
    // A caller passing this to a formatter gets the same answer the page's
    // "today" came from — never a second default that disagrees.
    await expect(viewerZone(null)).resolves.toBe(DEFAULT_TIMEZONE);
  });
});

describe(viewerToday, () => {
  beforeEach(() => {
    request.header = undefined;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("prefers the viewer's zone over the account's", async () => {
    // The bug this pins: the account's zone is where the reader signed up, so
    // answering from it tells a traveller the date they left behind.
    request.header = "Pacific/Kiritimati";

    await expect(todayIn("Etc/GMT+12")).resolves.toBe(
      isoDayIn(Date.now(), "Pacific/Kiritimati")
    );
  });

  it("falls back to the account's zone when the edge reported none", async () => {
    await expect(todayIn("Pacific/Kiritimati")).resolves.toBe(
      isoDayIn(Date.now(), "Pacific/Kiritimati")
    );
  });

  it("falls back to the constant when nothing names a zone", async () => {
    request.header = "Not/AZone";

    await expect(todayIn(null)).resolves.toBe(
      isoDayIn(Date.now(), DEFAULT_TIMEZONE)
    );
  });
});
