import { randomUUID } from "node:crypto";

import { hashPassword, verifyPassword } from "better-auth/crypto";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import "temporal-polyfill/global";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DrizzleDb } from "@/lib/db";
import {
  buildFixture,
  FIXTURE_EMAIL,
  FIXTURE_PASSWORD,
} from "@/lib/db/fixture";
import {
  applyFixture,
  loadCategoryIds,
  missingCategorySlugs,
  readFixtureState,
} from "@/lib/db/fixture-provision";
import { relations } from "@/lib/db/relations";
import { account, user } from "@/lib/db/schema/auth";
import { receipts } from "@/lib/db/schema/receipt";

/**
 * Exercises the DB-writing half of `pnpm db:fixture` against a scratch
 * database. It is skipped unless `FIXTURE_TEST_DATABASE_URL` is set, so the
 * normal suite stays Postgres-free and CI never runs it.
 *
 * The tests migrate the target, then truncate its tables, so the database name
 * must look like a scratch one.
 */
const connectionString = process.env.FIXTURE_TEST_DATABASE_URL;

const describeWithDatabase = connectionString ? describe : describe.skip;

const AS_OF = Temporal.PlainDate.from("2026-10-19");
const OWNER_EMAIL = "fixture-owner@example.com";
const OWNER_PASSWORD = "owner-secret-1234";

const assertScratchDatabase = (url: string) => {
  const name = new URL(url).pathname.replace(/^\//u, "");
  if (!/(?:fixture|test)/iu.test(name)) {
    throw new Error(
      `FIXTURE_TEST_DATABASE_URL must name a scratch database containing "test" or "fixture" (got "${name}").`
    );
  }
  return name;
};

if (connectionString) {
  assertScratchDatabase(connectionString);
}

let db: DrizzleDb;
let pool: Pool;

const truncate = async () => {
  await db.execute(
    sql`truncate table receipt_items, receipts, account, session, verification, "user" cascade`
  );
};

const credentialFor = async (email: string) => {
  const [row] = await db
    .select({
      id: account.id,
      password: account.password,
      updatedAt: account.updatedAt,
    })
    .from(account)
    .innerJoin(user, eq(account.userId, user.id))
    .where(eq(user.email, email))
    .limit(1);

  if (!row) {
    throw new Error(`No credential account for ${email}`);
  }
  const { password } = row;
  if (!password) {
    throw new Error(`Credential account for ${email} has no password`);
  }
  return { ...row, password };
};

describeWithDatabase(
  "fixture provisioning against Postgres",
  () => {
    beforeAll(async () => {
      pool = new Pool({ connectionString });
      db = drizzle({ client: pool, relations });
      await migrate(db, {
        migrationsFolder: new URL("../../drizzle", import.meta.url).pathname,
      });
      await truncate();
    }, 60_000);

    afterAll(async () => {
      await truncate();
      await pool.end();
    });

    it("creates a sign-in-able account and the corpus", async () => {
      const fixture = buildFixture({ asOf: AS_OF, email: FIXTURE_EMAIL });
      const categoryIds = await loadCategoryIds(db);
      expect(missingCategorySlugs(fixture, categoryIds)).toStrictEqual([]);

      const before = await readFixtureState(db, fixture);
      expect(before).toMatchObject({
        foreignReceipts: 0,
        userExists: false,
      });

      const applied = await applyFixture(db, { categoryIds, fixture });
      expect(applied).toMatchObject({
        accountCreated: true,
        itemsInserted: 160,
        passwordReset: false,
        receiptsInserted: 36,
        userCreated: true,
      });

      const credential = await credentialFor(FIXTURE_EMAIL);
      await expect(
        verifyPassword({
          hash: credential.password,
          password: FIXTURE_PASSWORD,
        })
      ).resolves.toBeTruthy();

      await expect(readFixtureState(db, fixture)).resolves.toMatchObject({
        accountExists: true,
        fixtureReceiptsPresent: 36,
        foreignReceipts: 0,
        passwordMatches: true,
        userExists: true,
      });
    });

    it("inserts nothing on a second run and leaves the account untouched", async () => {
      const fixture = buildFixture({ asOf: AS_OF, email: FIXTURE_EMAIL });
      const categoryIds = await loadCategoryIds(db);
      const before = await credentialFor(FIXTURE_EMAIL);

      const applied = await applyFixture(db, { categoryIds, fixture });
      expect(applied).toMatchObject({
        accountCreated: false,
        itemsInserted: 0,
        passwordReset: false,
        receiptsInserted: 0,
        userCreated: false,
      });

      const after = await credentialFor(FIXTURE_EMAIL);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    });

    it("repairs a drifted canonical password", async () => {
      const fixture = buildFixture({ asOf: AS_OF, email: FIXTURE_EMAIL });
      const categoryIds = await loadCategoryIds(db);
      const credential = await credentialFor(FIXTURE_EMAIL);

      await db
        .update(account)
        .set({ password: await hashPassword("drifted-password") })
        .where(eq(account.id, credential.id));

      const drifted = await readFixtureState(db, fixture);
      expect(drifted.passwordMatches).toBeFalsy();

      const applied = await applyFixture(db, { categoryIds, fixture });
      expect(applied).toMatchObject({
        accountCreated: false,
        passwordReset: true,
        receiptsInserted: 0,
      });

      const repaired = await credentialFor(FIXTURE_EMAIL);
      await expect(
        verifyPassword({ hash: repaired.password, password: FIXTURE_PASSWORD })
      ).resolves.toBeTruthy();
      await expect(
        verifyPassword({
          hash: repaired.password,
          password: "drifted-password",
        })
      ).resolves.toBeFalsy();
    });

    it("never resets another account's password and keeps its receipts", async () => {
      const ownerId = randomUUID();
      await db.insert(user).values({
        email: OWNER_EMAIL,
        emailVerified: true,
        id: ownerId,
        name: "Fixture owner",
      });
      await db.insert(account).values({
        accountId: ownerId,
        id: randomUUID(),
        password: await hashPassword(OWNER_PASSWORD),
        providerId: "credential",
        userId: ownerId,
      });
      await db.insert(receipts).values({
        id: randomUUID(),
        receiptNumber: "REAL-1",
        status: "done",
        userId: ownerId,
      });

      const fixture = buildFixture({ asOf: AS_OF, email: OWNER_EMAIL });
      const categoryIds = await loadCategoryIds(db);
      const state = await readFixtureState(db, fixture);
      expect(state.foreignReceipts).toBe(1);

      const applied = await applyFixture(db, { categoryIds, fixture });
      expect(applied).toMatchObject({
        accountCreated: false,
        passwordReset: false,
        receiptsInserted: 36,
      });

      const credential = await credentialFor(OWNER_EMAIL);
      await expect(
        verifyPassword({ hash: credential.password, password: OWNER_PASSWORD })
      ).resolves.toBeTruthy();

      const [real] = await db
        .select({ id: receipts.id })
        .from(receipts)
        .where(eq(receipts.receiptNumber, "REAL-1"));
      expect(real).toBeDefined();
    });
  },
  60_000
);
