import { cookies } from "next/headers";

import { resolveToday, TIMEZONE_COOKIE } from "@/lib/time";

/**
 * The zone the edge reported for this request.
 *
 * `undefined` off Cloudflare — in local development there is no `cf-timezone`
 * header and therefore no cookie — which leaves the account's zone to answer.
 * Server-only: the cookie is read through `next/headers`.
 */
export const viewerTimezone = async (): Promise<string | undefined> => {
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
