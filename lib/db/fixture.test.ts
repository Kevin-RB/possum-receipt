import "temporal-polyfill/global";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { buildFixture } from "@/lib/db/fixture";
import { wallClockToISODate } from "@/lib/receipt/datetime";
import { reconcile } from "@/lib/receipt/integrity";

const AS_OF = Temporal.PlainDate.from("2026-10-17");
const EMAIL = "trace-test@example.com";

const fixture = buildFixture({ asOf: AS_OF, email: EMAIL });

/**
 * The leaf categories seeded by
 * `drizzle/20260925043050_spicy_centennial/migration.sql`. The fixture may only
 * reference leaves, so an unknown slug is a bug the generator should not ship.
 */
const LEAF_SLUGS = new Set([
  "produce",
  "dairy-eggs",
  "meat-seafood",
  "bakery",
  "pantry",
  "frozen",
  "snacks",
  "drinks",
  "household",
  "health-beauty",
  "restaurant",
  "cafe",
  "fast-food",
  "beer-wine",
  "spirits",
  "fuel",
  "public-transport",
  "parking-tolls",
  "rideshare",
  "pharmacy",
  "medical-dental",
  "fitness",
  "homewares",
  "garden",
  "tools",
  "streaming",
  "events",
  "hobbies",
  "card-surcharge",
  "service-fee",
  "store-discount",
  "loyalty-discount",
]);

const isoDates = () =>
  fixture.receipts.map((receipt) =>
    wallClockToISODate(receipt.transactionDateTime)
  );

describe(buildFixture, () => {
  it("is deterministic for the same seed, email and anchor date", () => {
    expect(buildFixture({ asOf: AS_OF, email: EMAIL })).toStrictEqual(fixture);
  });

  it("normalizes the email and reports the anchor date", () => {
    const mixed = buildFixture({
      asOf: AS_OF,
      email: "  Trace-Test@Example.com ",
    });
    expect(mixed.email).toBe(EMAIL);
    expect(mixed.asOf).toBe("2026-10-17");
  });

  it("namespaces receipt ids by account", () => {
    const other = buildFixture({ asOf: AS_OF, email: "other@example.com" });
    const ids = new Set(fixture.receipts.map((receipt) => receipt.id));

    expect(other.receipts.some((receipt) => ids.has(receipt.id))).toBeFalsy();
  });

  it("uses valid UUIDs for receipt ids", () => {
    for (const receipt of fixture.receipts) {
      expect(z.uuid().safeParse(receipt.id).success).toBeTruthy();
    }
  });

  it("spreads three receipts across each of the trailing twelve months", () => {
    const months = new Set(isoDates().map((date) => date.slice(0, 7)));

    expect(fixture.receipts).toHaveLength(36);
    expect(months.size).toBe(12);
  });

  it("never dates a receipt after the anchor date or before the window", () => {
    const earliest = AS_OF.subtract({ months: 11 }).with({ day: 1 });

    for (const date of isoDates()) {
      expect(date <= "2026-10-17").toBeTruthy();
      expect(date >= earliest.toString()).toBeTruthy();
    }
  });

  it("reconciles every receipt with its total unless it is flagged", () => {
    for (const receipt of fixture.receipts) {
      const result = reconcile(receipt.items, { total: receipt.total });

      expect(result.matches).toBe(!receipt.hasIntegrityWarning);
    }

    for (const receipt of fixture.receipts.filter(
      (candidate) => !candidate.hasIntegrityWarning
    )) {
      expect(
        reconcile(receipt.items, { total: receipt.total }).itemsSum
      ).toBeCloseTo(receipt.total, 2);
    }
  });

  it("sets the integrity warning only on receipts whose items miss the total", () => {
    const warned = fixture.receipts.filter(
      (receipt) => receipt.hasIntegrityWarning
    );

    expect(warned).toHaveLength(1);
    expect(
      reconcile(warned[0].items, { total: warned[0].total }).matches
    ).toBeFalsy();
  });

  it("includes several merchants with repeat visits", () => {
    const visits = new Map<string, number>();
    for (const receipt of fixture.receipts) {
      if (receipt.merchantName) {
        visits.set(
          receipt.merchantName,
          (visits.get(receipt.merchantName) ?? 0) + 1
        );
      }
    }

    expect(visits.size).toBeGreaterThanOrEqual(6);
    expect(Math.min(...visits.values())).toBeGreaterThanOrEqual(2);
  });

  it("includes one receipt with no merchant", () => {
    const anonymous = fixture.receipts.filter(
      (receipt) => receipt.merchantName === null
    );

    expect(anonymous).toHaveLength(1);
    expect(anonymous[0].merchantAbn).toBeNull();
    expect(anonymous[0].merchantAddress).toBeNull();
    expect(anonymous[0].merchantStoreId).toBeNull();
  });

  it("stores subtotal and GST only where the receipt prints them", () => {
    const withBreakdown = fixture.receipts.filter(
      (receipt) => receipt.subtotal !== null
    );

    expect(withBreakdown).toHaveLength(18);
    for (const receipt of fixture.receipts) {
      expect(receipt.gst === null).toBe(receipt.subtotal === null);
    }
  });

  it("covers every payment method", () => {
    const methods = new Set(
      fixture.receipts.map((receipt) => receipt.paymentMethod)
    );

    expect([...methods].toSorted()).toStrictEqual(["card", "cash", "other"]);
  });

  it("includes at least one surcharge and one negative discount", () => {
    const surcharges = fixture.receipts.flatMap((receipt) =>
      receipt.items.filter((line) => line.kind === "surcharge")
    );
    const discounts = fixture.receipts.flatMap((receipt) =>
      receipt.items.filter((line) => line.kind === "discount")
    );

    expect(surcharges.length).toBeGreaterThanOrEqual(1);
    expect(surcharges.every((line) => line.lineTotal > 0)).toBeTruthy();
    expect(discounts.length).toBeGreaterThanOrEqual(1);
    expect(discounts.every((line) => line.lineTotal < 0)).toBeTruthy();
  });

  it("leaves some line items uncategorised", () => {
    const uncategorised = fixture.receipts.flatMap((receipt) =>
      receipt.items.filter((line) => line.categorySlug === null)
    );

    expect(uncategorised.length).toBeGreaterThanOrEqual(3);
  });

  it("classifies items across many leaf categories", () => {
    const slugs = new Set(
      fixture.receipts.flatMap((receipt) =>
        receipt.items
          .map((line) => line.categorySlug)
          .filter((slug): slug is string => slug !== null)
      )
    );

    expect(slugs.size).toBeGreaterThanOrEqual(8);
    for (const slug of slugs) {
      expect(
        LEAF_SLUGS.has(slug),
        `unknown category slug: ${slug}`
      ).toBeTruthy();
    }
  });

  it("keeps product line totals equal to unit price times quantity", () => {
    for (const receipt of fixture.receipts) {
      for (const line of receipt.items) {
        if (line.kind !== "product") {
          continue;
        }
        expect(line.lineTotal).toBe(
          Math.round(line.unitPrice * line.quantity * 100) / 100
        );
      }
    }
  });
});
