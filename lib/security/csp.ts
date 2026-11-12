/**
 * The Content-Security-Policy the app reports against, built per request.
 *
 * It is deliberately a pure function of its inputs: the policy depends on the
 * deployment's storage endpoint, the Inngest endpoint and one fresh nonce per
 * request, so nothing about it can be resolved when the config is read. It is
 * served as `Content-Security-Policy-Report-Only` — see `proxy.ts` for the
 * rollout reason.
 */
export interface ContentSecurityPolicyOptions {
  /** Per-request value Next stamps onto its own inline scripts. */
  nonce: string;
  /** Development needs `'unsafe-eval'` for React's server-error reconstruction. */
  isDevelopment: boolean;
  /** The endpoint browsers PUT uploads to; scheme-less values are accepted. */
  storageEndpoint?: string;
  /** Inngest's API base URL, the source of the dev realtime socket origin. */
  inngestBaseUrl?: string;
}

// Endpoints may be scheme-less (`localhost:9000`, `rustfs:9000`) or full URLs,
// matching `lib/storage/client.ts`.
const withScheme = (endpoint: string): string =>
  /^https?:\/\//iu.test(endpoint) ? endpoint : `http://${endpoint}`;

const originOf = (endpoint: string): string =>
  new URL(withScheme(endpoint)).origin;

/**
 * CSP matches `wss:` separately from `https:`, so the realtime origin is
 * rewritten rather than listed as its HTTP equivalent.
 */
const webSocketOriginOf = (endpoint: string): string => {
  const url = new URL(withScheme(endpoint));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.origin;
};

export const createNonce = (): string => btoa(crypto.randomUUID());

export const buildContentSecurityPolicy = ({
  inngestBaseUrl,
  isDevelopment,
  nonce,
  storageEndpoint,
}: ContentSecurityPolicyOptions): string => {
  // The browser PUTs uploads straight to storage with a presigned URL, so the
  // storage origin is a connect target; `img-src` carries it too for anything
  // that renders an object directly.
  const storageOrigin = storageEndpoint ? originOf(storageEndpoint) : null;
  const realtimeOrigin = isDevelopment
    ? webSocketOriginOf(inngestBaseUrl ?? "http://localhost:8288")
    : "wss://api.inngest.com";

  return [
    "default-src 'self'",
    // `'strict-dynamic'` lets a trusted script load its own dependencies
    // (next-themes' bootstrap, Next's chunks) instead of widening the list of
    // trusted hosts. `'unsafe-eval'` is development-only: React's enhanced
    // error stacks use `eval`, and nothing does in production.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDevelopment ? " 'unsafe-eval'" : ""}`,
    // Tailwind and Next emit inline styles; a nonce would have to reach every
    // one of them, so inline styles stay allowed.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${storageOrigin ? ` ${storageOrigin}` : ""}`,
    `connect-src 'self'${storageOrigin ? ` ${storageOrigin}` : ""} ${realtimeOrigin}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
};
