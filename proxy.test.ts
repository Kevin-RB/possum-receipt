import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { proxy } from "@/proxy";

/**
 * The viewer's zone reaches server components as a cookie written from the
 * edge's `cf-timezone` header. It is transport, not a preference: rewritten on
 * every response, so travelling changes "today" without anyone editing a
 * setting — and every page response carries it, including the bounce to
 * sign-in, so the value exists before the account does.
 */

const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers });

const SESSION = { cookie: "better-auth.session_token=token" };

describe("the viewer timezone cookie", () => {
  it("is written from the edge header on a signed-in page request", () => {
    const response = proxy(
      request("/overview", { ...SESSION, "cf-timezone": "America/Bogota" })
    );

    expect(response.cookies.get("tz")?.value).toBe("America/Bogota");
  });

  it("is rewritten from the header, so it follows the viewer", () => {
    const response = proxy(
      request("/overview", {
        ...SESSION,
        "cf-timezone": "Asia/Tokyo",
        cookie: "better-auth.session_token=token; tz=America/Bogota",
      })
    );

    expect(response.cookies.get("tz")?.value).toBe("Asia/Tokyo");
  });

  it("is written on the redirect to sign-in as well", () => {
    const response = proxy(
      request("/overview", { "cf-timezone": "Asia/Tokyo" })
    );

    expect(response.cookies.get("tz")?.value).toBe("Asia/Tokyo");
  });

  it("stays absent when nothing reported a zone, as in local development", () => {
    const response = proxy(request("/overview", SESSION));

    expect(response.cookies.get("tz")).toBeUndefined();
  });
});

/**
 * Local requests never touch Cloudflare, so the page path would otherwise only
 * ever be exercised through its fallback. `DEV_TIMEZONE` stands in for the edge,
 * and it has to arrive the same way the real header does — on the forwarded
 * request — or the code under test is a different code path.
 */
const forwarded = (response: Response) =>
  response.headers.get("x-middleware-request-cf-timezone");

describe("the development stand-in", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is forwarded as a request header, so server components read it", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TIMEZONE", "America/Bogota");

    const response = proxy(request("/overview", SESSION));

    expect(forwarded(response)).toBe("America/Bogota");
    expect(response.cookies.get("tz")?.value).toBe("America/Bogota");
  });

  it("loses to a real edge header", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TIMEZONE", "America/Bogota");

    const response = proxy(
      request("/overview", { ...SESSION, "cf-timezone": "Asia/Tokyo" })
    );

    expect(forwarded(response)).toBe("Asia/Tokyo");
  });

  it("is ignored outside development", () => {
    // A deployment builds with NODE_ENV=production and a client cannot set an
    // environment variable, so the stand-in exists only on a developer's
    // machine. (The client-controlled input is the header itself, which any
    // request may carry and `resolveTimezone` validates.)
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DEV_TIMEZONE", "America/Bogota");

    const response = proxy(request("/overview", SESSION));

    expect(forwarded(response)).toBeNull();
    expect(response.cookies.get("tz")).toBeUndefined();
  });

  it("is ignored when it does not name a zone", () => {
    // A typo in an env var must not become a cookie every reader skips.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TIMEZONE", "Not/AZone");

    const response = proxy(request("/overview", SESSION));

    expect(forwarded(response)).toBeNull();
    expect(response.cookies.get("tz")).toBeUndefined();
  });

  it("is ignored when unset", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TIMEZONE", "");

    const response = proxy(request("/overview", SESSION));

    expect(forwarded(response)).toBeNull();
  });

  it("leaves an existing cookie alone when no stand-in is set", () => {
    // A cookie is state, not just this request's copy: a chat turn pins one
    // from the browser's own zone. Clearing it here would throw that away on
    // the request after it was written.
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DEV_TIMEZONE", "");

    const response = proxy(
      request("/overview", {
        ...SESSION,
        cookie: "better-auth.session_token=token; tz=America/Bogota",
      })
    );

    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
