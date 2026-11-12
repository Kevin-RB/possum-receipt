import { describe, expect, it } from "vitest";

import { buildContentSecurityPolicy, createNonce } from "./csp";

const nonce = "abc123";

const directives = (policy: string) => policy.split("; ");

describe(buildContentSecurityPolicy, () => {
  it("names the storage origin in production and keeps eval out", () => {
    const policy = buildContentSecurityPolicy({
      isDevelopment: false,
      nonce,
      storageEndpoint: "https://uploads.tribi.dev",
    });

    expect(policy).toBe(
      "default-src 'self'; " +
        "script-src 'self' 'nonce-abc123' 'strict-dynamic'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: https://uploads.tribi.dev; " +
        "connect-src 'self' https://uploads.tribi.dev wss://api.inngest.com; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    expect(policy).not.toContain("unsafe-eval");
  });

  it("omits the storage origin when the deployment has none", () => {
    const policy = buildContentSecurityPolicy({
      isDevelopment: false,
      nonce,
    });

    expect(directives(policy)).toContain("img-src 'self' data: blob:");
    expect(directives(policy)).toContain(
      "connect-src 'self' wss://api.inngest.com"
    );
    expect(policy).not.toContain("localhost");
  });

  it("normalises a scheme-less storage endpoint", () => {
    const policy = buildContentSecurityPolicy({
      isDevelopment: false,
      nonce,
      storageEndpoint: "localhost:9000",
    });

    expect(directives(policy)).toContain(
      "img-src 'self' data: blob: http://localhost:9000"
    );
  });

  it("allows eval and the dev realtime socket in development", () => {
    const policy = buildContentSecurityPolicy({
      inngestBaseUrl: "http://localhost:8288",
      isDevelopment: true,
      nonce,
      storageEndpoint: "localhost:9000",
    });

    expect(policy).toBe(
      "default-src 'self'; " +
        "script-src 'self' 'nonce-abc123' 'strict-dynamic' 'unsafe-eval'; " +
        "style-src 'self' 'unsafe-inline'; " +
        "img-src 'self' data: blob: http://localhost:9000; " +
        "connect-src 'self' http://localhost:9000 ws://localhost:8288; " +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
  });

  it("upgrades an https Inngest base URL to wss", () => {
    const policy = buildContentSecurityPolicy({
      inngestBaseUrl: "https://inner.example",
      isDevelopment: true,
      nonce,
    });

    expect(directives(policy)).toContain(
      "connect-src 'self' wss://inner.example"
    );
  });
});

describe(createNonce, () => {
  it("is unique per call and survives Next's nonce grammar", () => {
    const first = createNonce();
    const second = createNonce();

    expect(first).not.toBe(second);
    // `getScriptNonceFromHeader` only matches `'nonce-([A-Za-z0-9+/_-]+={0,2})'`.
    expect(first).toMatch(/^[A-Za-z0-9+/_-]+={0,2}$/u);
  });
});
