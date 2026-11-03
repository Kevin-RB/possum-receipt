import { headers } from "next/headers";

import { isTimezone, resolveToday } from "@/lib/time";
import { warnOnce } from "@/lib/warn-once";

/**
 * The zone to pretend the viewer is in, in local development only.
 *
 * Local requests bypass Cloudflare, so `cf-timezone` never exists here and the
 * viewer path can only ever fall back. `DEV_TIMEZONE` stands in for the edge —
 * `DEV_TIMEZONE=America/Bogota pnpm dev` — and every surface then resolves the
 * same way it does in a deployment.
 *
 * Two guards: the check is for `development` exactly, so `pnpm start` and every
 * deployed build (itself built with `NODE_ENV=production`) ignore it, and the
 * value must name a real zone or a typo would travel as one.
 */
const devTimezone = (): string | undefined => {
  if (process.env.NODE_ENV !== "development") {
    return;
  }

  const configured = process.env.DEV_TIMEZONE;
  return isTimezone(configured) ? configured : undefined;
};

/**
 * The zone the edge reported for this request, or `undefined` when nothing did.
 *
 * `cf-timezone` comes from Cloudflare's **Add visitor location headers** Managed
 * Transform, which is per zone and off by default. When it is missing in a
 * deployment nothing errors — every surface falls back to the account's zone —
 * so the absence is worth one line in the log rather than none: from then on,
 * "today" is the reader's home day instead of the day they are on.
 *
 * Server-only: both reads go through `next/headers`.
 */
export const viewerTimezone = async (): Promise<string | undefined> => {
  const requestHeaders = await headers();
  const fromEdge = requestHeaders.get("cf-timezone");

  if (fromEdge) {
    return fromEdge;
  }

  if (process.env.NODE_ENV === "production") {
    warnOnce(
      "viewer-timezone",
      "[viewer-timezone] no cf-timezone header: pages fall back to the account's zone. Enable Cloudflare's Add visitor location headers Managed Transform for this zone."
    );
  }

  return devTimezone();
};

/**
 * The viewer's "today" for a server render: the zone the edge reported, then
 * the zone the account was created in, then the constant.
 *
 * Resolved once per page so every chart, bound and query in it agrees on the
 * day. Pass the result down rather than letting a component read the clock:
 * a client component is server-rendered too, and the two clocks disagree for
 * any viewer not in the server's zone.
 */
export const viewerToday = async (
  accountTimezone?: string | null
): Promise<Temporal.PlainDate> =>
  resolveToday(await viewerTimezone(), accountTimezone);
