import { headers } from "next/headers";

import { isTimezone, resolveToday, resolveTimezone } from "@/lib/time";
import { warnOnce } from "@/lib/warn-once";

/**
 * The header the hosting edge puts the viewer's zone on: Vercel's
 * `x-vercel-ip-timezone`, in IANA form (`Australia/Brisbane`).
 *
 * It only arrives on the direct path, so it is there because
 * `receipts.tribi.dev` is a **DNS-only** record in front of Vercel. Behind
 * Cloudflare's proxy the zone would describe Cloudflare's edge instead of the
 * reader, which is why the record is not proxied.
 */
const EDGE_TIMEZONE_HEADER = "x-vercel-ip-timezone";

/**
 * The zone to pretend the viewer is in, in local development only.
 *
 * Local requests bypass the edge, so the header never exists here and the
 * viewer path can only ever fall back. `DEV_TIMEZONE` stands in for it —
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
 * In a deployment the header is on every request Vercel answers. When it is
 * missing nothing errors — every surface falls back to the account's zone — so
 * the absence is worth one line in the log rather than none: from then on,
 * "today" is the reader's home day instead of the day they are on. The likely
 * cause is the app's DNS record being proxied again, or the app having been
 * pointed somewhere other than Vercel.
 *
 * Server-only: the read goes through `next/headers`.
 */
export const viewerTimezone = async (): Promise<string | undefined> => {
  const requestHeaders = await headers();
  const fromEdge = requestHeaders.get(EDGE_TIMEZONE_HEADER);

  if (fromEdge) {
    return fromEdge;
  }

  if (process.env.NODE_ENV === "production") {
    warnOnce(
      "viewer-timezone",
      "[viewer-timezone] no x-vercel-ip-timezone header: pages fall back to the account's zone. Is receipts.tribi.dev still a DNS-only record in front of Vercel?"
    );
  }

  return devTimezone();
};

/**
 * The one zone a request should use: the edge's, then the account's, then the
 * constant.
 *
 * Everything that needs a zone reads this — the day, a pending receipt's upload
 * time, the assistant's prompt — and nothing composes the chain itself. A
 * second composition is how two surfaces end up answering "which day is it"
 * differently, so `resolveTimezone` is called here and nowhere else.
 */
export const viewerZone = async (
  accountTimezone?: string | null
): Promise<string> => resolveTimezone(await viewerTimezone(), accountTimezone);

/**
 * Both halves of the viewer's clock, walked once.
 *
 * A page that needs the zone *and* the day asks for them together, so the one
 * composition of the chain stays here: the two answers are computed from the
 * same zone by construction, not by a caller remembering to derive one from the
 * other.
 */
export const viewerClock = async (
  accountTimezone?: string | null
): Promise<{ timezone: string; today: Temporal.PlainDate }> => {
  const timezone = await viewerZone(accountTimezone);
  return { timezone, today: resolveToday(timezone) };
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
): Promise<Temporal.PlainDate> => {
  const clock = await viewerClock(accountTimezone);
  return clock.today;
};
