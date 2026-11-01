import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { TIMEZONE_COOKIE } from "@/lib/time";

const PUBLIC_PATHS = new Set(["/sign-in", "/sign-up"]);

/**
 * Carries the edge's `cf-timezone` header into a cookie server components can
 * read, on every page response including the redirect to sign-in.
 *
 * The cookie is transport, not a preference: rewritten from the header on each
 * request, so it follows the viewer when they travel. It is not a setting and
 * has no UI. Absent in local development, where nothing sets the header — the
 * account's stored zone covers that.
 */
const withViewerTimezone = (request: NextRequest, response: NextResponse) => {
  const timezone = request.headers.get("cf-timezone");

  if (timezone) {
    response.cookies.set(TIMEZONE_COOKIE, timezone, {
      path: "/",
      sameSite: "lax",
    });
  }

  return response;
};

export const proxy = (request: NextRequest) => {
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
      request,
      NextResponse.redirect(new URL("/sign-in", request.url))
    );
  }

  return withViewerTimezone(request, NextResponse.next());
};

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
