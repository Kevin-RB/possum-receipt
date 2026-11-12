import type { NextConfig } from "next";

const isProduction = process.env.NODE_ENV === "production";

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
  output: "standalone",
};

export default nextConfig;
