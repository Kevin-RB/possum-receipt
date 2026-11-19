import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

/**
 * Production migrations, run as the first step of the Vercel build.
 *
 * Vercel has no release phase, so the build is the only moment that is both
 * after the commit exists and before the deployment serves it: `next build`
 * failing stops the promotion, and the previous deployment keeps answering.
 * Migrating at app start would be wrong for the opposite reason — a serverless
 * instance starts many times per deployment, on several instances at once, and
 * each start would race the others.
 *
 * `VERCEL_ENV` is the guard, and it is what makes a preview build harmless:
 * Vercel sets it to `preview` there, so a preview can never migrate whatever
 * `DATABASE_URL` resolves to, even one mis-pointed at production. Locally it is
 * unset, so `pnpm build` skips this too.
 */
const isVercelProductionBuild = () => process.env.VERCEL_ENV === "production";

const main = async (): Promise<void> => {
  if (!isVercelProductionBuild()) {
    console.log(
      `[migrate] VERCEL_ENV=${process.env.VERCEL_ENV ?? "(unset)"}: not a production Vercel build, skipping migrations.`
    );
    return;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error(
      "[migrate] DATABASE_URL is not set for this production build. Vercel needs it available to the Build step, not only at runtime."
    );
  }

  const pool = new Pool({
    application_name: "receipt-app-migrate",
    connectionString,
    max: 1,
  });

  try {
    await migrate(drizzle({ client: pool }), {
      migrationsFolder: "./drizzle",
    });
    console.log("[migrate] every pending migration is applied.");
  } finally {
    await pool.end();
  }
};

await main();
