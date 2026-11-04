import { describe, expect, it, vi } from "vitest";

// @ts-expect-error the adapter only calls back into `db` at request time
vi.mock(import("@/lib/db"), () => ({ db: {} }));

process.env.BETTER_AUTH_URL = "http://localhost:3000";

const { auth } = await import("@/lib/auth");

describe("auth wiring", () => {
  it("registers the invite-code gate as a before hook", () => {
    expect(auth.options.hooks?.before).toBeTypeOf("function");
  });

  it("accepts an invite code input field on sign-up", () => {
    expect(auth.options.user?.additionalFields?.inviteCode).toMatchObject({
      input: true,
      returned: false,
      type: "string",
    });
  });

  it("captures the account's timezone as an optional sign-up field", () => {
    // Optional and nullable by design: Better Auth writes what the form sends,
    // and an account created before the column existed has no zone at all.
    // `resolveTimezone` treats both the same.
    expect(auth.options.user?.additionalFields?.timezone).toMatchObject({
      input: true,
      required: false,
      type: "string",
    });
  });

  it("enables rate limiting", () => {
    expect(auth.options.rateLimit?.enabled).toBeTruthy();
  });

  it("limits sign-up attempts per IP", () => {
    expect(
      auth.options.rateLimit?.customRules?.["/sign-up/email"]
    ).toMatchObject({ max: 5, window: 60 });
  });

  it("resolves the client IP from the Cloudflare proxy header", () => {
    expect(auth.options.advanced?.ipAddress?.ipAddressHeaders).toContain(
      "cf-connecting-ip"
    );
  });
});
