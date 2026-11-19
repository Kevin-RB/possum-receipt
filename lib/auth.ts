import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/lib/db";
import { account, session, user, verification } from "@/lib/db/schema/auth";

import { assertInviteCode } from "./auth/invite-code";

export const auth = betterAuth({
  advanced: {
    // Vercel **overwrites** `x-forwarded-for` with the requester's address and
    // does not forward an external one, so it cannot be spoofed on the way in.
    // This matters twice: the `/sign-up/email` rate limit is the brake on
    // invite-code guessing, and the address is stored on sessions. The old
    // `cf-connecting-ip` header is gone with the Cloudflare proxy — with a
    // DNS-only record a client can send any value it likes, which would have
    // handed it a fresh rate-limit bucket per request.
    ipAddress: {
      ipAddressHeaders: ["x-forwarded-for"],
    },
  },
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { account, session, user, verification },
  }),
  emailAndPassword: {
    enabled: true,
  },
  hooks: {
    // The middleware contract requires an async handler even though the
    // gate itself only reads the request body.
    // eslint-disable-next-line require-await
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") {
        return;
      }
      const raw = ctx.body?.inviteCode;
      assertInviteCode(typeof raw === "string" ? raw : null);
    }),
  },
  plugins: [nextCookies()],
  rateLimit: {
    customRules: {
      "/sign-up/email": {
        max: 5,
        window: 60,
      },
    },
    enabled: true,
  },
  user: {
    additionalFields: {
      inviteCode: {
        input: true,
        required: false,
        returned: false,
        // The gate validates the code in a hook; it is never persisted.
        transform: { input: () => null },
        type: "string",
      },
      timezone: {
        input: true,
        required: false,
        // The zone the account was created in, sent by the sign-up form from
        // the browser. A stored fallback for "today" when a request carries no
        // viewer zone; `resolveTimezone` validates it on read.
        type: "string",
      },
    },
  },
});

export type Session = typeof auth.$Infer.Session;
