/**
 * The zone the browser is running in — the viewer's own clock, asked directly.
 *
 * Only a browser can answer this: a server rendering the page has its own zone,
 * which is the whole reason "today" is resolved once and passed down. Used for
 * the two things the browser has to state for itself: the account's zone at
 * sign-up, and the zone a chat turn carries.
 *
 * Deliberately its own module, with no imports: `lib/time.ts` opens with the
 * `temporal-polyfill/global` side effect, and both call sites are client
 * components, so reaching through it would ship the whole polyfill to the
 * browser to read one `Intl` property.
 */
export const browserTimezone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;
