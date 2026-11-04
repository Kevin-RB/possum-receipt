import "temporal-polyfill/global";
import { db } from "@/lib/db";
import type { Fixture } from "@/lib/db/fixture";
import { buildFixture, FIXTURE_PASSWORD } from "@/lib/db/fixture";
import { FixtureUsageError, parseFixtureOptions } from "@/lib/db/fixture-args";
import type {
  AppliedFixture,
  FixtureState,
  PasswordOutcome,
} from "@/lib/db/fixture-provision";
import {
  appliedPasswordOutcome,
  applyFixture,
  isBlockedByForeignReceipts,
  isCanonicalFixtureAccount,
  loadCategoryIds,
  missingCategorySlugs,
  plannedPasswordOutcome,
  readFixtureState,
} from "@/lib/db/fixture-provision";
import { RECEIPT_TIMEZONE, wallClockToISODate } from "@/lib/receipt/datetime";

const lineItemCount = (fixture: Fixture) =>
  fixture.receipts.reduce((sum, receipt) => sum + receipt.items.length, 0);

const dateRange = (fixture: Fixture) => {
  const dates = fixture.receipts
    .map((receipt) => wallClockToISODate(receipt.transactionDateTime))
    .toSorted();
  return `${dates[0]} .. ${dates.at(-1)}`;
};

const sharedSummaryLines = (fixture: Fixture) => [
  `  date range:  ${dateRange(fixture)}`,
  `  images:      none (the detail page shows "No image available")`,
];

const describePassword = (outcome: PasswordOutcome, future: boolean) => {
  switch (outcome) {
    case "created": {
      return future
        ? `will be set to ${FIXTURE_PASSWORD}`
        : `set to ${FIXTURE_PASSWORD}`;
    }
    case "reset": {
      return future
        ? `will be reset to ${FIXTURE_PASSWORD} (it does not match)`
        : `reset to ${FIXTURE_PASSWORD} (it did not match)`;
    }
    case "matches": {
      return `already matches ${FIXTURE_PASSWORD}`;
    }
    case "unchanged": {
      return future
        ? "left unchanged (the account already exists)"
        : "left unchanged (the account already existed)";
    }
    default: {
      const unhandled: never = outcome;
      return unhandled;
    }
  }
};

const describeSignIn = (fixture: Fixture, outcome: PasswordOutcome) =>
  outcome === "unchanged"
    ? `Sign in at /sign-in with ${fixture.email} using its existing password; this run did not reset it.`
    : `Sign in at /sign-in with ${fixture.email} and ${FIXTURE_PASSWORD}.`;

const printPlan = (fixture: Fixture, state: FixtureState) => {
  const passwordLine = describePassword(
    plannedPasswordOutcome(state, isCanonicalFixtureAccount(fixture.email)),
    true
  );

  process.stdout.write(
    `${[
      `Fixture for ${fixture.email} (dry run — pass --apply to write)`,
      `  user:        ${state.userExists ? "exists" : "will be created"}`,
      `  password:    ${passwordLine}`,
      `  receipts:    ${fixture.receipts.length - state.fixtureReceiptsPresent} to insert, ${state.fixtureReceiptsPresent} already present`,
      `  line items:  ${lineItemCount(fixture)} in the corpus`,
      ...sharedSummaryLines(fixture),
      state.foreignReceipts > 0
        ? `  other rows:  ${state.foreignReceipts} existing receipt(s) left untouched (--force)`
        : "",
      "No changes written.",
    ]
      .filter(Boolean)
      .join("\n")}\n`
  );
};

const printApplied = (
  fixture: Fixture,
  state: FixtureState,
  applied: AppliedFixture
) => {
  const passwordOutcome = appliedPasswordOutcome(
    applied,
    isCanonicalFixtureAccount(fixture.email)
  );

  process.stdout.write(
    `${[
      `Provisioned fixture for ${fixture.email}`,
      `  user:        ${applied.userCreated ? "created" : "exists"}`,
      `  password:    ${describePassword(passwordOutcome, false)}`,
      `  receipts:    inserted ${applied.receiptsInserted}, ${state.fixtureReceiptsPresent} already present`,
      `  line items:  inserted ${applied.itemsInserted}`,
      ...sharedSummaryLines(fixture),
      state.foreignReceipts > 0
        ? `  other rows:  ${state.foreignReceipts} existing receipt(s) left untouched`
        : "",
      "",
      describeSignIn(fixture, passwordOutcome),
    ]
      .filter(Boolean)
      .join("\n")}\n`
  );
};

const main = async () => {
  const options = parseFixtureOptions(process.argv.slice(2));
  const asOf = Temporal.Now.instant()
    .toZonedDateTimeISO(RECEIPT_TIMEZONE)
    .toPlainDate();
  const fixture = buildFixture({ asOf, email: options.email });

  const categoryIds = await loadCategoryIds(db);
  const missing = missingCategorySlugs(fixture, categoryIds);
  if (missing.length > 0) {
    throw new Error(
      `Missing categories: ${missing.join(", ")}. Run pnpm db:migrate first.`
    );
  }

  const state = await readFixtureState(db, fixture);

  if (isBlockedByForeignReceipts(state, options.force)) {
    process.stderr.write(
      `${[
        `${fixture.email} already has ${state.foreignReceipts} receipt(s) that are not part of the fixture.`,
        "Pass --force to add the fixture receipts alongside them; none of those receipts are modified.",
        "Nothing was written.",
      ].join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }

  if (!options.apply) {
    printPlan(fixture, state);
    return;
  }

  printApplied(
    fixture,
    state,
    await applyFixture(db, { categoryIds, fixture })
  );
};

try {
  await main();
} catch (error) {
  if (error instanceof FixtureUsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await db.$client.end();
}
