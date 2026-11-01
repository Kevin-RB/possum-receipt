import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

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
