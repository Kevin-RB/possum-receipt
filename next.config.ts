import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

/**
 * `output: "standalone"` is the Docker image's format (`runner` copies
 * `.next/standalone`), and it must not be set on Vercel: Next 16.3's standalone
 * finalizer reads `.next/next-server.js.nft.json`, which the deployment adapter
 * Vercel injects stops Next from writing, so the build dies in
 * `onBuildComplete` with ENOENT. The fix is on canary only (16.4.0), not
 * backported to 16.3.x, and Vercel does not use standalone output anyway —
 * vercel/next.js#96646.
 *
 * `VERCEL` is set on every Vercel build, including a local `vercel build`.
 */
const standaloneForDockerOnly: "standalone" | undefined = process.env.VERCEL
  ? undefined
  : "standalone";

/**
 * Headers that do not depend on the environment. The Content-Security-Policy is
 * not here: it needs one fresh nonce per request and the deployment's storage
 * origin, so it is built at request time in `proxy.ts`.
 */
const nextConfig: NextConfig = {
  allowedDevOrigins: ["kevin"],
  headers: () => [
    {
      headers: [
        // HSTS over plain http on localhost would make the dev server
        // unreachable over http for as long as the browser remembers it.
        ...(isProduction
          ? [
              {
                key: "Strict-Transport-Security",
                value: "max-age=63072000; includeSubDomains",
              },
            ]
          : []),
        { key: "X-Content-Type-Options", value: "nosniff" },
        {
          key: "Referrer-Policy",
          value: "strict-origin-when-cross-origin",
        },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=()",
        },
        { key: "X-Frame-Options", value: "DENY" },
        // Clickjacking protection is safe to enforce on its own; everything
        // else stays report-only until the policy has been watched.
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ],
      source: "/:path*",
    },
  ],
  output: standaloneForDockerOnly,
};

export default nextConfig;
