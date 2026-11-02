import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { isTimezone, TIMEZONE_COOKIE } from "@/lib/time";

const PUBLIC_PATHS = new Set(["/sign-in", "/sign-up"]);

/**
 * The zone to pretend the viewer is in, in local development only.
 *
 * Local requests bypass Cloudflare, so `cf-timezone` never exists here and the
 * page path can only ever fall back. `DEV_TIMEZONE` lets a developer stand in
 * for the edge — `DEV_TIMEZONE=America/Bogota pnpm dev` — and the rest of the
 * code then runs exactly as it does in a deployment.
 *
 * Two guards: the check is for `development` exactly, so `pnpm start` and every
 * deployed build (which build with `NODE_ENV=production`) inject nothing — a
 * client cannot set an environment variable — and the value must name a real
 * zone, or a typo would be mirrored into a cookie every reader then skips.
 */
const devViewerZone = (): string | null => {
  if (process.env.NODE_ENV !== "development") {
    return null;
  }

  const configured = process.env.DEV_TIMEZONE;
  return isTimezone(configured) ? configured : null;
};

/** What the edge said, or what development was told to pretend. */
const viewerZone = (request: NextRequest): string | null =>
  request.headers.get("cf-timezone") ?? devViewerZone();

/**
 * Mirror the zone into a cookie, and give the rest of the request the header a
 * deployment would have had.
 *
 * The cookie is transport, not a preference: rewritten on each request, so it
 * follows the viewer when they travel. It is not a setting and has no UI. The
 * forwarded header is what server components read first (`lib/viewer.ts`), so
 * the development stand-in travels by the same route as the real one.
 */
const withViewerTimezone = (
  response: NextResponse,
  timezone: string | null
) => {
  if (timezone) {
    response.cookies.set(TIMEZONE_COOKIE, timezone, {
      path: "/",
      sameSite: "lax",
    });
  } else if (process.env.NODE_ENV === "development") {
    // Nothing here writes the cookie but a stand-in, so a value left behind by
    // an earlier `DEV_TIMEZONE` run would outlive the variable and quietly keep
    // answering. Development has one source — the variable, or the fallbacks —
    // and this is what makes unsetting it return to Brisbane. Never in a
    // deployment, where an absent header must leave the cookie alone.
    response.cookies.delete(TIMEZONE_COOKIE);
  }

  return response;
};

export const proxy = (request: NextRequest) => {
  const timezone = viewerZone(request);

  // Optimistic check only — the real validation is server-side, in each page's
  // `requireSession()` (see `lib/auth/dal.ts`), which is where the session is
  // read close to the data. Public paths are never redirected here: a stale
  // cookie must not bounce users away from /sign-in, or the page's own check
  // would send them back forever.
  if (
    !PUBLIC_PATHS.has(request.nextUrl.pathname) &&
    !getSessionCookie(request)
  ) {
    return withViewerTimezone(
      NextResponse.redirect(new URL("/sign-in", request.url)),
      timezone
    );
  }

  const requestHeaders = new Headers(request.headers);
  if (timezone && !requestHeaders.has("cf-timezone")) {
    requestHeaders.set("cf-timezone", timezone);
  }

  return withViewerTimezone(
    NextResponse.next({ request: { headers: requestHeaders } }),
    timezone
  );
};

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
