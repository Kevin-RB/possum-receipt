import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createAuthMiddleware } from "better-auth/api";
import { betterAuth } from "better-auth/minimal";
import { nextCookies } from "better-auth/next-js";

import { db } from "@/lib/db";
import { account, session, user, verification } from "@/lib/db/schema/auth";

import { assertInviteCode } from "./auth/invite-code";

export const auth = betterAuth({
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["cf-connecting-ip"],
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
