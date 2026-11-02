import "temporal-polyfill/global";

/**
 * The fallback for work with no viewer behind it: a job, a script, a request
 * that carries neither a viewer's zone nor an account's.
 */
export const DEFAULT_TIMEZONE = "Australia/Brisbane";

/**
 * Where the edge's `cf-timezone` header lands for server code to read.
 *
 * Transport, not a preference: `proxy.ts` rewrites it on every page request, so
 * it follows the viewer when they travel and is never a setting to edit.
 */
export const TIMEZONE_COOKIE = "tz";

/**
 * Whether a value names a real IANA zone. `Temporal` validates the name, which
 * an `Intl` lookup would also do, but this is the value that is about to be
 * used as a zone, so it is the thing that gets asked.
 */
const isZoneName = (value: string): boolean => {
  try {
    Temporal.Now.plainDateISO(value);
    return true;
  } catch {
    // An unknown or malformed zone name, which is the answer either way.
    return false;
  }
};

/**
 * Whether a value names a real IANA zone.
 *
 * The proxy uses it to decide whether a development override is a zone at all,
 * so a typo in an env var is ignored rather than written into a cookie that
 * every reader would then skip.
 */
export const isTimezone = (value: unknown): value is string =>
  typeof value === "string" && isZoneName(value);

/**
 * The first candidate that names a real zone, or `DEFAULT_TIMEZONE`.
 *
 * Candidates arrive in priority order — the viewer's zone, then the account's.
 * They cross boundaries the app does not own (a cookie, a request body), so
 * every candidate is taken as unknown and one that names nothing is dropped
 * rather than thrown: a bad value must not crash a render, and the next one is
 * always worth trying.
 */
export const resolveTimezone = (...candidates: unknown[]): string =>
  candidates.find(isTimezone) ?? DEFAULT_TIMEZONE;

/**
 * "Today", for the viewer that resolved to those candidates.
 *
 * A receipt's own day is stored data — the date part of its printed wall clock
 * (ADR-0015) — and never comes from here. This answers only "what day is it
 * now", a question about the clock in front of the reader.
 */
export const resolveToday = (...candidates: unknown[]): Temporal.PlainDate =>
  Temporal.Now.plainDateISO(resolveTimezone(...candidates));

const WEEKDAY_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  timeZone: "UTC",
  weekday: "long",
});

/**
 * The day's weekday name — "Sunday".
 *
 * Built as a `Date` at UTC holding the plain date's components and read back in
 * UTC, the same carrier `lib/receipt/datetime.ts` uses for receipt dates:
 * handing a `Temporal` object to `Intl` is not portable, and reading it in the
 * runtime's own zone would shift the day for anyone west of it.
 */
export const weekdayOf = (today: Temporal.PlainDate): string =>
  WEEKDAY_FORMATTER.format(
    new Date(Date.UTC(today.year, today.month - 1, today.day))
  );
