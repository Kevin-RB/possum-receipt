# ADR-0019: Security headers, HSTS without preload, and a report-only CSP

Date: 2026-11-12

## Status

Accepted

## Context

The app sent no security headers of its own. Cloudflare is its only public ingress (ADR-0005) and terminates TLS, so everything a reader sees arrives over HTTPS — but nothing told a browser to _insist_ on that, nothing restricted where scripts could come from, and any site could frame the app.

The threat these headers address is not the owner's network. The home network is closed and the Mac mini is reachable only through the Cloudflare tunnel. The exposed hop is the **reader's**: the network between a browser and Cloudflare — a café, hotel or airport wifi — which neither the home network nor Cloudflare controls. An attacker there can intercept a plain-`http` request before Cloudflare ever sees it, and can only exploit a page that runs a script it should not.

The CSP has a constraint of its own. It needs a fresh nonce per request (Next stamps it onto its own inline scripts, and `next-themes` renders one Next does not stamp) and the deployment's storage origin, which the Docker build does not have (`STORAGE_PUBLIC_ENDPOINT` is a runtime variable). So it cannot be a static header in `next.config.ts`.

## Decision

**Static headers in `next.config.ts`; the CSP per request in `proxy.ts`, report-only.**

- **Static set, every path** (`next.config.ts`): `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`, `X-Frame-Options: DENY`, and an **enforced** `Content-Security-Policy: frame-ancestors 'none'`. Clickjacking protection breaks nothing the app does, so it is enforced from day one; the rest of the policy is not.
- **HSTS: `max-age=63072000; includeSubDomains`, production builds only, no `preload`.**
  - _What it does:_ once a browser has seen it over HTTPS, it rewrites every `http://receipts.tribi.dev` request to `https://` before anything leaves the device, and refuses a click-through on a certificate error. That closes the downgrade an attacker on the reader's network would otherwise use. The clock restarts on every visit.
  - _Production only_, because HSTS on `localhost` makes the dev server unreachable over plain http for as long as the browser remembers it.
  - _`includeSubDomains`_ covers `*.receipts.tribi.dev` — the sending host's own subdomains (RFC 6797 §8.1) — not its siblings. `uploads.tribi.dev`, `receipts-staging.tribi.dev` and `coolbox.tribi.dev` are untouched. Nothing lives under `receipts.tribi.dev` today, so it costs nothing.
  - _Two years_, not a short ramp. The usual reason to start at a day is fear of breaking HTTPS and stranding readers; here the certificate the browser sees is Cloudflare's edge certificate, managed and renewed by Cloudflare, so an origin-side TLS mistake never reaches the browser. A ramp would also be a stopgap with a follow-up to remember.
  - _No `preload`._ Preloading compiles the rule into browsers so even the very first visit is protected. The cost: the preload list is keyed on the **registered domain**, so it would bind `tribi.dev` and every current and future subdomain — Coolify's admin, the storage hosts, staging, anything added later — to HTTPS, and removal takes months of browser releases. The gain is one first visit per browser, for an invite-gated app reached through https links. Not worth it.
- **CSP, report-only, built per request** (`lib/security/csp.ts`, set in `proxy.ts`): `script-src 'self' 'nonce-…' 'strict-dynamic'` (plus `'unsafe-eval'` in development for React's error stacks), `style-src 'self' 'unsafe-inline'` (Tailwind and Next emit inline styles), `img-src`/`connect-src` naming the runtime storage origin and the Inngest realtime socket, `object-src 'none'`, `base-uri 'self'`. It is set on the forwarded request too, because Next reads the nonce from the request's CSP header; `x-nonce` carries the same value to the root layout, which hands it to `next-themes`.
- **Report-only until watched.** A wrong policy enforced on day one blanks the app; a wrong policy in report-only logs a console line. Enforcement is a later, separate change, made once a deployment has run without violations in the browser console across the app's surfaces (chat, overview, receipts, upload, sign-in). There is no reporting endpoint, so watching means a browser console, not a dashboard.

## Considered options

1. **Rely on Cloudflare alone.** Cloudflare can redirect http→https ("Always Use HTTPS") and has its own HSTS setting. The redirect does not help: the first `http` request is the one an attacker intercepts, and it is answered before the redirect exists. Cloudflare's HSTS would work, but it lives in a dashboard, not in the repo, where the next reader cannot see it beside the CSP it belongs with.
2. **HSTS with `preload`.** Rejected above: it binds all of `tribi.dev`, and it is the one setting here that cannot be taken back on a useful timescale.
3. **A short `max-age`, raised later.** Rejected above: the risk it hedges against does not reach the browser behind Cloudflare, and it leaves a follow-up behind.
4. **Enforce the CSP immediately.** Rejected: the policy has never been observed against a real deployment, and the cost of a mistake is a blank app.
5. **A static CSP in `next.config.ts`.** Cannot carry a per-request nonce, and the build has no storage origin, so the production policy would silently omit it.

## Consequences

- **HSTS is one-way for a browser that has seen it.** Undoing it means sending `max-age=0`, which a browser applies on its next HTTPS visit; one that never returns keeps the rule until its two years expire. `receipts.tribi.dev` can never be served over plain http to such a browser in that window. If Cloudflare's own HSTS setting (**SSL/TLS → Edge Certificates**) is ever turned on, it must agree with this header, or the two will fight over which value a browser stores.
- **Every route is dynamic.** The root layout calls `headers()` to read `x-nonce`, so no page is statically rendered. The app's pages were already per-request behind auth, so nothing was being cached that is lost.
- **`proxy.ts` has two jobs**: the optimistic session gate, and minting the nonce and policy. Its matcher excludes `/api`, `_next/static`, `_next/image` and the icons, so those responses carry the static set but no CSP — they are not documents.
- **Violations are invisible unless someone looks.** With no `report-to` endpoint, a report-only violation is a console line in one reader's browser. Adding an endpoint is telemetry work, deferred with the rest of it (ADR-0014).
- **A new origin is a CSP change.** Any new browser-side fetch, socket or image host (a new storage host, a third-party script) must be added to `lib/security/csp.ts`, or it will report now and break once the policy is enforced.

## Related

- ADR-0005 (Coolify deployment) — Cloudflare as the only ingress, and the deferred WAF rule on the storage hosts.
- ADR-0016 (today is the viewer's clock) — its "single job" line for `proxy.ts` is superseded by this ADR.
- PR #236 — the implementation.
