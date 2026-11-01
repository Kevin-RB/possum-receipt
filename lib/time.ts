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
 * The first candidate that names a real zone, or `DEFAULT_TIMEZONE`.
 *
 * Candidates arrive in priority order — the viewer's zone, then the account's.
 * They cross boundaries the app does not own (a cookie, a request body), so
 * every candidate is taken as unknown and one that names nothing is dropped
 * rather than thrown: a bad value must not crash a render, and the next one is
 * always worth trying.
 */
export const resolveTimezone = (...candidates: unknown[]): string =>
  candidates.find(
    (candidate): candidate is string =>
      typeof candidate === "string" && isZoneName(candidate)
  ) ?? DEFAULT_TIMEZONE;

/**
 * "Today", for the viewer that resolved to those candidates.
 *
 * A receipt's own day is stored data — the date part of its printed wall clock
 * (ADR-0015) — and never comes from here. This answers only "what day is it
 * now", a question about the clock in front of the reader.
 */
export const resolveToday = (...candidates: unknown[]): Temporal.PlainDate =>
  Temporal.Now.plainDateISO(resolveTimezone(...candidates));

/**
 * The zone the browser is running in — the viewer's own clock, asked directly.
 *
 * Only a browser can answer this: a server rendering the page has its own zone,
 * which is the whole reason "today" is resolved once and passed down. Used for
 * the two things the browser has to state for itself: the account's zone at
 * sign-up, and the zone a chat turn carries.
 */
export const browserTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;
