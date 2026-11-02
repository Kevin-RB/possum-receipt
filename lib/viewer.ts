import { cookies, headers } from "next/headers";

import { resolveToday, TIMEZONE_COOKIE } from "@/lib/time";

/**
 * The zone the edge reported for this request, or `undefined` when nothing did.
 *
 * Two transports, in order of freshness:
 *
 * 1. the `cf-timezone` request header — Cloudflare adds it to the request
 *    itself, so it is right on the *first* render after someone travels;
 * 2. the `tz` cookie `proxy.ts` writes from that header — for a request that
 *    arrives without it (local development, LAN access, a future proxy). The
 *    cookie is one request behind, which is why the header is asked first.
 *
 * Server-only: both reads go through `next/headers`.
 */
export const viewerTimezone = async (): Promise<string | undefined> => {
  const requestHeaders = await headers();
  const fromEdge = requestHeaders.get("cf-timezone");

  if (fromEdge) {
    return fromEdge;
  }

  const cookieStore = await cookies();
  return cookieStore.get(TIMEZONE_COOKIE)?.value;
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
