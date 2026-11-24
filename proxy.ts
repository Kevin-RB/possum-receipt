import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { buildContentSecurityPolicy, createNonce } from "@/lib/security/csp";

const PUBLIC_PATHS = new Set(["/sign-in", "/sign-up"]);

/**
 * Resolved the same way `lib/storage/client.ts` resolves it, because the policy
 * has to name the host the presigned URL actually uses. The CSP is built per
 * request for the nonce; this origin comes along with it, and `proxy.ts` is
 * compiled for the edge, so `STORAGE_PUBLIC_ENDPOINT` is inlined at build time.
 * That is why the variable must be in the Build scope and not only at runtime:
 * a deployment missing it there reports against a policy with no storage origin
 * while the app itself keeps working (ADR-0019).
 */
const storageEndpoint = () =>
  process.env.STORAGE_PUBLIC_ENDPOINT ??
  process.env.STORAGE_ENDPOINT ??
  "localhost:9000";

export const proxy = (request: NextRequest) => {
  // Optimistic check only — the real validation is server-side, in each page's
  // `requireSession()` (see `lib/auth/dal.ts`), which is where the session is
  // read close to the data. Public paths are never redirected here: a stale
  // cookie must not bounce users away from /sign-in, or the page's own check
  // would send them back forever.
  //
  // Nothing about "today" belongs here: the viewer's zone is read straight from
  // the request in `lib/viewer.ts`, and a middleware copy would only be a second
  // place to forget to update.
  if (
    !PUBLIC_PATHS.has(request.nextUrl.pathname) &&
    !getSessionCookie(request)
  ) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }

  const nonce = createNonce();
  const contentSecurityPolicy = buildContentSecurityPolicy({
    inngestBaseUrl: process.env.INNGEST_BASE_URL,
    isDevelopment: process.env.NODE_ENV === "development",
    nonce,
    storageEndpoint: storageEndpoint(),
  });

  // Next reads the nonce from the `Content-Security-Policy(-Report-Only)`
  // *request* header (see `getScriptNonceFromHeader`), so the policy has to be
  // on the forwarded request as well as on the response. `x-nonce` is the
  // documented way for the tree to read the same value — the root layout hands
  // it to `next-themes`, whose inline script is the one Next does not stamp.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set(
    "Content-Security-Policy-Report-Only",
    contentSecurityPolicy
  );
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(
    "Content-Security-Policy-Report-Only",
    contentSecurityPolicy
  );

  return response;
};

export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|icon.svg).*)"],
};
