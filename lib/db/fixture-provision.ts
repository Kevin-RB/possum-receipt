import { randomUUID } from "node:crypto";

import { hashPassword, verifyPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";

import type { DrizzleDb } from "@/lib/db";
import type { Fixture } from "@/lib/db/fixture";
import { FIXTURE_EMAIL, FIXTURE_PASSWORD } from "@/lib/db/fixture";
import { account, user } from "@/lib/db/schema/auth";
import { categories } from "@/lib/db/schema/category";
import type { ReceiptInsert } from "@/lib/db/schema/receipt";
import { receipts } from "@/lib/db/schema/receipt";
import { receiptItems } from "@/lib/db/schema/receipt-item";

/**
 * The database half of `pnpm db:fixture`, separate from the CLI so it can be
 * driven by a test against a scratch database. Every function takes the
 * connection: the script passes the app's `db`, the integration test its own.
 */

/**
 * Better Auth identifies a password account by `providerId` and `accountId`
 * alone, and the sign-up path uses these two values (`accountId` is the user
 * id). The fixture copies them so its account is indistinguishable from a
 * signed-up one.
 */
const CREDENTIAL_PROVIDER = "credential";

export interface FixtureState {
  accountExists: boolean;
  fixtureReceiptsPresent: number;
  foreignReceipts: number;
  /** Null when there is no credential account at all. */
  passwordMatches: boolean | null;
  userExists: boolean;
}

export interface AppliedFixture {
  accountCreated: boolean;
  itemsInserted: number;
  passwordReset: boolean;
  receiptsInserted: number;
  userCreated: boolean;
}

export type PasswordOutcome = "created" | "matches" | "reset" | "unchanged";

export const isCanonicalFixtureAccount = (email: string) =>
  email === FIXTURE_EMAIL;

/**
 * True when `hash` is a stored password for the fixture password. A malformed
 * hash is a mismatch, not a crash: the whole point is to repair the account.
 */
export const passwordMatchesFixture = async (hash: string | null) => {
  if (!hash) {
    return false;
  }
  try {
    return await verifyPassword({ hash, password: FIXTURE_PASSWORD });
  } catch {
    return false;
  }
};

/**
 * An account with receipts of its own is only touched when the caller says so.
 * The rows are never modified either way; this is about not seeding fixture data
 * into a real account by accident.
 */
export const isBlockedByForeignReceipts = (
  state: Pick<FixtureState, "foreignReceipts">,
  force: boolean
) => state.foreignReceipts > 0 && !force;

export const loadCategoryIds = async (db: DrizzleDb) => {
  const rows = await db
    .select({ id: categories.id, slug: categories.slug })
    .from(categories);
  return new Map(rows.map((row) => [row.slug, row.id]));
};

export const missingCategorySlugs = (
  fixture: Fixture,
  categoryIds: Map<string, string>
) => {
  const slugs = new Set<string>();
  for (const receipt of fixture.receipts) {
    for (const line of receipt.items) {
      if (line.categorySlug) {
        slugs.add(line.categorySlug);
      }
    }
  }
  return [...slugs].filter((slug) => !categoryIds.has(slug)).toSorted();
};

export const readFixtureState = async (
  db: DrizzleDb,
  fixture: Fixture
): Promise<FixtureState> => {
  const [existingUser] = await db
    .select()
    .from(user)
    .where(eq(user.email, fixture.email))
    .limit(1);

  if (!existingUser) {
    return {
      accountExists: false,
      fixtureReceiptsPresent: 0,
      foreignReceipts: 0,
      passwordMatches: null,
      userExists: false,
    };
  }

  const [credential] = await db
    .select({ id: account.id, password: account.password })
    .from(account)
    .where(
      and(
        eq(account.userId, existingUser.id),
        eq(account.providerId, CREDENTIAL_PROVIDER)
      )
    )
    .limit(1);
  const passwordMatches = credential
    ? await passwordMatchesFixture(credential.password)
    : null;

  const existingReceipts = await db
    .select({ id: receipts.id })
    .from(receipts)
    .where(eq(receipts.userId, existingUser.id));
  const fixtureIds = new Set(fixture.receipts.map((receipt) => receipt.id));

  return {
    accountExists: Boolean(credential),
    fixtureReceiptsPresent: existingReceipts.filter((receipt) =>
      fixtureIds.has(receipt.id)
    ).length,
    foreignReceipts: existingReceipts.filter(
      (receipt) => !fixtureIds.has(receipt.id)
    ).length,
    passwordMatches,
    userExists: true,
  };
};

/**
 * The canonical fixture account's password is part of its contract, so a drift
 * (someone changed it, or the row came from a different run) is repaired. Any
 * other account — the owner's included — keeps its password: it is only ever
 * given one when the account is created here.
 */
export const plannedPasswordOutcome = (
  state: Pick<FixtureState, "accountExists" | "passwordMatches">,
  canonical: boolean
): PasswordOutcome => {
  if (!state.accountExists) {
    return "created";
  }
  if (!canonical) {
    return "unchanged";
  }
  return state.passwordMatches ? "matches" : "reset";
};

export const appliedPasswordOutcome = (
  applied: AppliedFixture,
  canonical: boolean
): PasswordOutcome => {
  if (applied.accountCreated) {
    return "created";
  }
  if (applied.passwordReset) {
    return "reset";
  }
  return canonical ? "matches" : "unchanged";
};

const displayName = (email: string) => `Fixture ${email.split("@")[0]}`;

export const applyFixture = async (
  db: DrizzleDb,
  {
    categoryIds,
    fixture,
  }: { categoryIds: Map<string, string>; fixture: Fixture }
): Promise<AppliedFixture> =>
  await db.transaction(async (tx) => {
    const [existingUser] = await tx
      .select()
      .from(user)
      .where(eq(user.email, fixture.email))
      .limit(1);

    const userId = existingUser?.id ?? randomUUID();
    if (!existingUser) {
      await tx.insert(user).values({
        email: fixture.email,
        emailVerified: true,
        id: userId,
        name: displayName(fixture.email),
      });
    }

    const [credential] = await tx
      .select({ id: account.id, password: account.password })
      .from(account)
      .where(
        and(
          eq(account.userId, userId),
          eq(account.providerId, CREDENTIAL_PROVIDER)
        )
      )
      .limit(1);

    const accountCreated = !credential;
    let passwordReset = false;
    if (accountCreated) {
      await tx.insert(account).values({
        accountId: userId,
        id: randomUUID(),
        password: await hashPassword(FIXTURE_PASSWORD),
        providerId: CREDENTIAL_PROVIDER,
        userId,
      });
    } else if (
      isCanonicalFixtureAccount(fixture.email) &&
      !(await passwordMatchesFixture(credential.password))
    ) {
      // The canonical account's credentials are part of the fixture contract,
      // so a drifted password is repaired rather than reported. Matching
      // passwords are left alone, which keeps a re-run a true no-op.
      await tx
        .update(account)
        .set({ password: await hashPassword(FIXTURE_PASSWORD) })
        .where(eq(account.id, credential.id));
      passwordReset = true;
    }

    const insertedReceipts = await tx
      .insert(receipts)
      .values(
        fixture.receipts.map(
          (receipt): ReceiptInsert => ({
            categorizedAt: receipt.categorizedAt,
            createdAt: receipt.createdAt,
            gst: receipt.gst,
            hasIntegrityWarning: receipt.hasIntegrityWarning,
            id: receipt.id,
            merchantAbn: receipt.merchantAbn,
            merchantAddress: receipt.merchantAddress,
            merchantName: receipt.merchantName,
            merchantStoreId: receipt.merchantStoreId,
            paymentMethod: receipt.paymentMethod,
            receiptNumber: receipt.receiptNumber,
            status: receipt.status,
            subtotal: receipt.subtotal,
            total: receipt.total,
            transactionDateTime: receipt.transactionDateTime,
            userId,
          })
        )
      )
      .onConflictDoNothing()
      .returning({ id: receipts.id });

    const insertedIds = new Set(insertedReceipts.map((receipt) => receipt.id));
    const itemRows = fixture.receipts.flatMap((receipt) =>
      insertedIds.has(receipt.id)
        ? receipt.items.map((line) => ({
            categoryId: line.categorySlug
              ? (categoryIds.get(line.categorySlug) ?? null)
              : null,
            categorySource: "ai" as const,
            kind: line.kind,
            lineTotal: line.lineTotal,
            name: line.name,
            quantity: line.quantity,
            receiptId: receipt.id,
            unitPrice: line.unitPrice,
          }))
        : []
    );

    if (itemRows.length > 0) {
      await tx.insert(receiptItems).values(itemRows);
    }

    return {
      accountCreated,
      itemsInserted: itemRows.length,
      passwordReset,
      receiptsInserted: insertedReceipts.length,
      userCreated: !existingUser,
    };
  });
