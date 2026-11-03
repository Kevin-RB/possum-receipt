import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { proxy } from "@/proxy";

/**
 * The proxy's one job is the optimistic session gate. It knows nothing about
 * "today": the viewer's zone is read from the request by `lib/viewer.ts`, so
 * there is no cookie to write and no second copy to keep in step.
 */
const request = (path: string, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${path}`, { headers });

const SESSION = { cookie: "better-auth.session_token=token" };

describe("the session gate", () => {
  it("sends a signed-out visitor to sign-in", () => {
    const response = proxy(request("/overview"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/sign-in");
  });

  it("lets a signed-in visitor through", () => {
    const response = proxy(request("/overview", SESSION));

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("never redirects away from a public path", () => {
    // A stale cookie must not bounce someone off /sign-in, or the page's own
    // check would send them back forever.
    for (const path of ["/sign-in", "/sign-up"]) {
      expect(proxy(request(path)).headers.get("location")).toBeNull();
    }
  });
});
