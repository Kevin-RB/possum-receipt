import { parseArgs } from "node:util";

import { z } from "zod";

import { FIXTURE_EMAIL } from "@/lib/db/fixture";

export const FIXTURE_USAGE = [
  "Usage: pnpm db:fixture [--email <address>] [--apply] [--force]",
  `--email defaults to the agent test account, ${FIXTURE_EMAIL}.`,
].join("\n");

/**
 * A problem with how the command was invoked, as opposed to a failure while
 * writing. The script prints the message (which includes the usage line) and
 * exits non-zero without a stack trace.
 */
export class FixtureUsageError extends Error {
  override name = "FixtureUsageError";
}

export interface FixtureOptions {
  /** Write the fixture. The command is a read-only dry run without it. */
  apply: boolean;
  email: string;
  /**
   * Add the fixture receipts to an account that already has receipts of its
   * own. Without it the command refuses rather than mixing fixture data into a
   * real account by accident. Other owners' rows are never touched either way.
   */
  force: boolean;
}

/**
 * Writing fixture rows is a development action, so the command runs only where
 * it can vouch for the environment. `NODE_ENV=production` is the case the
 * ticket names; an unset `NODE_ENV` is refused for the same reason — a deployed
 * container sets neither, and would otherwise point this at the real
 * `DATABASE_URL`.
 */
export const assertFixtureEnvironment = (
  env: { NODE_ENV?: string | undefined } = process.env
) => {
  const environment = env.NODE_ENV;
  if (environment === "development" || environment === "test") {
    return;
  }
  if (environment === "production") {
    throw new FixtureUsageError(
      "Refusing to run against a production environment (NODE_ENV=production)."
    );
  }
  throw new FixtureUsageError(
    `Refusing to run with NODE_ENV ${environment ?? "unset"}; set NODE_ENV=development.`
  );
};

const emailSchema = z.email();

export const parseFixtureOptions = (
  argv: string[],
  env: { NODE_ENV?: string | undefined } = process.env
): FixtureOptions => {
  assertFixtureEnvironment(env);

  let parsed: {
    apply: boolean;
    email?: string | undefined;
    force: boolean;
  };
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        apply: { default: false, type: "boolean" },
        email: { type: "string" },
        force: { default: false, type: "boolean" },
      },
      strict: true,
    });
    parsed = values;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new FixtureUsageError(`${reason}\n${FIXTURE_USAGE}`);
  }

  const email = (parsed.email ?? FIXTURE_EMAIL).trim().toLowerCase();
  if (!emailSchema.safeParse(email).success) {
    throw new FixtureUsageError(`Invalid email address: ${email}`);
  }

  return {
    apply: parsed.apply,
    email,
    force: parsed.force,
  };
};
