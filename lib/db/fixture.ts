import { createHash } from "node:crypto";

import "temporal-polyfill/global";

import type { PaymentMethod, ReceiptInsert } from "@/lib/db/schema/receipt";
import type {
  LineItemKind,
  ReceiptItemInsert,
} from "@/lib/db/schema/receipt-item";
import {
  receiptDateTimeToWallClock,
  wallClockToInstant,
} from "@/lib/receipt/datetime";

/**
 * The agent test account, and the default `--email`. An agent that reaches for
 * `pnpm db:fixture --apply` therefore provisions and refreshes exactly the
 * account browser checks are expected to use. The owner's account is never a
 * default: targeting it is an explicit `--email` (and `--force`).
 */
export const FIXTURE_EMAIL = "trace-test@example.com";

/**
 * The password every fixture account is created with. Fixed on purpose: the
 * command prints it, and an agent signing in needs the same value on every
 * machine. It is a development credential and never leaves `pnpm db:fixture`.
 */
export const FIXTURE_PASSWORD = "fixture-pass-1234";

/**
 * Fixed PRNG seed. The generator is a pure function of the seed, the email and
 * the anchor date, so two runs produce identical rows (ADR-0013).
 */
const FIXTURE_SEED = 20_261_017;

const MONTHS = 12;
const RECEIPTS_PER_MONTH = 3;
const RECEIPT_COUNT = MONTHS * RECEIPTS_PER_MONTH;
/** Highest day-of-month any receipt uses, so every month has the same span. */
const MONTH_DAY_LIMIT = 28;
const OPENING_HOUR = 8;
const OPENING_HOURS = 12;
const MINUTE_STEP = 5;
const PRICE_JITTER = 0.1;
const CARD_SURCHARGE_RATE = 0.005;
const LOYALTY_DISCOUNT_RATE = 0.1;
/** The cents the warned receipt's stated total is off by. */
const INTEGRITY_GAP_CENTS = 250;

/** Index of the receipt with no merchant name. */
const ANONYMOUS_MERCHANT_INDEX = 13;
/** Index of the receipt whose line items deliberately miss its total. */
const INTEGRITY_WARNING_INDEX = 19;

const PAYMENT_METHODS: PaymentMethod[] = ["card", "cash", "other"];

type Random = () => number;

/** Linear congruential PRNG (Numerical Recipes constants). */
const createRandom = (seed: number): Random => {
  let state = seed % 4_294_967_296;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
};

const shuffle = <T>(values: readonly T[], random: Random): T[] => {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled;
};

/**
 * A UUID derived from the seed, the account's email and a name. Deterministic
 * ids are what make a second run a no-op: the insert is `ON CONFLICT DO
 * NOTHING`, so the existing fixture rows are left exactly as they were.
 */
const fixtureUuid = (email: string, name: string): string => {
  const hash = createHash("sha256")
    .update(`${FIXTURE_SEED}:${email}:${name}`)
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // eslint-disable-next-line no-bitwise -- RFC 4122 version and variant bits are bitwise by definition
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  // eslint-disable-next-line no-bitwise -- see above
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
};

const pad = (value: number) => value.toString().padStart(2, "0");

const toDollars = (cents: number) => Math.round(cents) / 100;

interface CatalogueItem {
  categorySlug: string | null;
  name: string;
  priceCents: number;
}

interface Merchant {
  abn: string;
  address: string;
  items: CatalogueItem[];
  name: string;
  storeId: string;
}

export interface FixtureItem extends Omit<
  ReceiptItemInsert,
  "categoryId" | "categorySource" | "id" | "receiptId"
> {
  categorySlug: string | null;
  kind: LineItemKind;
  lineTotal: number;
  name: string;
  quantity: number;
  unitPrice: number;
}

/**
 * A receipt's insert row, minus the fields the provisioner supplies (the owner)
 * or that the fixture intentionally leaves absent (object key, transcript,
 * claim stamp). The remaining columns are the schema's own insert type, so a
 * column rename cannot drift away from this fixture silently.
 */
export interface FixtureReceipt extends Omit<
  ReceiptInsert,
  | "categorizedAt"
  | "createdAt"
  | "gst"
  | "hasIntegrityWarning"
  | "id"
  | "merchantName"
  | "status"
  | "subtotal"
  | "total"
  | "transactionDateTime"
  | "userId"
> {
  categorizedAt: Date;
  createdAt: Date;
  gst: number | null;
  hasIntegrityWarning: boolean;
  id: string;
  items: FixtureItem[];
  merchantName: string | null;
  status: "done";
  subtotal: number | null;
  total: number;
  transactionDateTime: string;
}

export interface Fixture {
  asOf: string;
  email: string;
  receipts: FixtureReceipt[];
}

const catalogueItem = (
  name: string,
  priceCents: number,
  categorySlug: string | null
): CatalogueItem => ({ categorySlug, name, priceCents });

const GROCERY_ITEMS: CatalogueItem[] = [
  catalogueItem("Bananas 1kg", 349, "produce"),
  catalogueItem("Apples Pink Lady 1kg", 549, "produce"),
  catalogueItem("Tomatoes 250g", 299, "produce"),
  catalogueItem("Avocado each", 199, "produce"),
  catalogueItem("Milk 2L", 355, "dairy-eggs"),
  catalogueItem("Free-range Eggs 12", 749, "dairy-eggs"),
  catalogueItem("Cheddar 250g", 590, "dairy-eggs"),
  catalogueItem("Greek Yoghurt 1kg", 650, "dairy-eggs"),
  catalogueItem("Chicken Breast 500g", 899, "meat-seafood"),
  catalogueItem("Beef Mince 500g", 799, "meat-seafood"),
  catalogueItem("Salmon Fillet 250g", 1299, "meat-seafood"),
  catalogueItem("Sourdough Loaf", 550, "bakery"),
  catalogueItem("Croissants 4pk", 450, "bakery"),
  catalogueItem("Pasta 500g", 250, "pantry"),
  catalogueItem("Basmati Rice 1kg", 400, "pantry"),
  catalogueItem("Olive Oil 750ml", 1250, "pantry"),
  catalogueItem("Coffee Beans 250g", 899, "pantry"),
  catalogueItem("Dish Soap 500ml", 450, "household"),
  catalogueItem("Laundry Liquid 1L", 850, "household"),
  catalogueItem("Toilet Paper 6pk", 699, "household"),
  catalogueItem("Frozen Peas 1kg", 350, "frozen"),
  catalogueItem("Ice Cream 1L", 650, "frozen"),
  catalogueItem("Tim Tams 200g", 400, "snacks"),
  catalogueItem("Salt & Vinegar Chips", 320, "snacks"),
  catalogueItem("Orange Juice 1L", 450, "drinks"),
  catalogueItem("Sparkling Water 6pk", 600, "drinks"),
  catalogueItem("Toothpaste", 550, "health-beauty"),
  catalogueItem("Shampoo 400ml", 900, "health-beauty"),
];

const MERCHANTS: Merchant[] = [
  {
    abn: "93 111 222 333",
    address: "123 Smith St, Fitzroy VIC 3065",
    items: GROCERY_ITEMS,
    name: "Coles",
    storeId: "0342",
  },
  {
    abn: "61 078 402 371",
    address: "45 Swanston St, Melbourne VIC 3000",
    items: GROCERY_ITEMS,
    name: "Woolworths",
    storeId: "4570",
  },
  {
    abn: "81 004 126 018",
    address: "15 Boundary Rd, North Melbourne VIC 3051",
    items: [
      catalogueItem("Bread Loaf", 229, "bakery"),
      catalogueItem("Milk 2L", 279, "dairy-eggs"),
      catalogueItem("Free-range Eggs 12", 549, "dairy-eggs"),
      catalogueItem("Bananas 1kg", 249, "produce"),
      catalogueItem("Chicken Thighs 1kg", 899, "meat-seafood"),
      catalogueItem("Pasta 500g", 149, "pantry"),
      catalogueItem("Frozen Berries 500g", 399, "frozen"),
      catalogueItem("Dark Chocolate 200g", 249, "snacks"),
      catalogueItem("Laundry Powder 2kg", 799, "household"),
      catalogueItem("Miscellaneous", 275, null),
    ],
    name: "Aldi",
    storeId: "1108",
  },
  {
    abn: "43 619 298 123",
    address: "88 Lygon St, Carlton VIC 3053",
    items: [
      catalogueItem("Cordless Drill 18V", 14_900, "tools"),
      catalogueItem("Picture Hooks 10pk", 750, "tools"),
      catalogueItem("Duct Tape", 850, "tools"),
      catalogueItem("Extension Cord 5m", 2490, "tools"),
      catalogueItem("Potting Mix 25L", 1090, "garden"),
      catalogueItem("Herb Seeds", 450, "garden"),
      catalogueItem("Storage Tub 50L", 1500, "homewares"),
      catalogueItem("LED Bulb 4pk", 1990, "homewares"),
      catalogueItem("Assorted Sundries", 425, null),
    ],
    name: "Bunnings",
    storeId: "2234",
  },
  {
    abn: "74 090 459 029",
    address: "330 Edward St, Brisbane QLD 4000",
    items: [
      catalogueItem("Unleaded 95", 8750, "fuel"),
      catalogueItem("Regular Coffee", 500, "cafe"),
      catalogueItem("Meat Pie", 650, "fast-food"),
      catalogueItem("Chocolate Bar", 350, "snacks"),
      catalogueItem("Sports Drink 600ml", 480, "drinks"),
      catalogueItem("Iced Coffee 500ml", 450, "drinks"),
    ],
    name: "7-Eleven",
    storeId: "7789",
  },
  {
    abn: "21 600 152 084",
    address: "2/99 Chapel St, Windsor VIC 3181",
    items: [
      catalogueItem("Storage Basket", 800, "homewares"),
      catalogueItem("Throw Rug", 2500, "homewares"),
      catalogueItem("Scented Candle", 700, "homewares"),
      catalogueItem("Jigsaw Puzzle 1000pc", 1500, "hobbies"),
      catalogueItem("Kids Craft Kit", 1200, "hobbies"),
      catalogueItem("Notebook", 450, null),
    ],
    name: "Kmart",
    storeId: "0612",
  },
  {
    abn: "80 005 401 523",
    address: "71 Gladstone Rd, Highgate Hill QLD 4101",
    items: [
      catalogueItem("Paracetamol 20pk", 299, "pharmacy"),
      catalogueItem("Vitamin C 100pk", 1499, "pharmacy"),
      catalogueItem("Electric Toothbrush", 4999, "pharmacy"),
      catalogueItem("Sunscreen SPF50", 1899, "health-beauty"),
      catalogueItem("Body Wash 500ml", 799, "health-beauty"),
    ],
    name: "Chemist Warehouse",
    storeId: "3905",
  },
  {
    abn: "52 173 992 002",
    address: "18 Stanley St, South Brisbane QLD 4101",
    items: [
      catalogueItem("Pale Ale 6pk", 2200, "beer-wine"),
      catalogueItem("Shiraz 750ml", 1800, "beer-wine"),
      catalogueItem("Vodka 700ml", 4200, "spirits"),
      catalogueItem("Sparkling Wine 750ml", 2600, "beer-wine"),
    ],
    name: "BWS",
    storeId: "8440",
  },
  {
    abn: "33 909 112 455",
    address: "12 Given Terrace, Paddington QLD 4064",
    items: [
      catalogueItem("Flat White", 550, "cafe"),
      catalogueItem("Almond Croissant", 650, "cafe"),
      catalogueItem("Eggs Benedict", 2200, "cafe"),
      catalogueItem("BLT", 1500, "cafe"),
      catalogueItem("Batch Brew", 500, "cafe"),
    ],
    name: "The Green Owl Cafe",
    storeId: "0001",
  },
  {
    abn: "47 221 883 901",
    address: "205 Brunswick St, Fortitude Valley QLD 4006",
    items: [
      catalogueItem("Margherita Pizza", 2200, "restaurant"),
      catalogueItem("Spaghetti Bolognese", 2600, "restaurant"),
      catalogueItem("Garlic Bread", 900, "restaurant"),
      catalogueItem("House Red 250ml", 1100, "beer-wine"),
      catalogueItem("Tiramisu", 1200, "restaurant"),
    ],
    name: "Little Italy Trattoria",
    storeId: "0002",
  },
];

const jitterPrice = (cents: number, random: Random): number => {
  const spread = Math.round(cents * PRICE_JITTER);
  const offset = Math.round((random() * 2 - 1) * spread);
  return Math.max(50, cents + offset);
};

const pickProducts = (merchant: Merchant, random: Random) => {
  const count = Math.min(2 + Math.floor(random() * 5), merchant.items.length);
  return shuffle(merchant.items, random).slice(0, count);
};

const productLine = (entry: CatalogueItem, random: Random): FixtureItem => {
  const unitPriceCents = jitterPrice(entry.priceCents, random);
  const quantity = random() < 0.2 ? 2 : 1;

  return {
    categorySlug: entry.categorySlug,
    kind: "product",
    lineTotal: toDollars(unitPriceCents * quantity),
    name: entry.name,
    quantity,
    unitPrice: toDollars(unitPriceCents),
  };
};

const sumLineTotals = (items: FixtureItem[]): number =>
  items.reduce((sum, line) => sum + line.lineTotal, 0);

const buildReceipt = (
  index: number,
  merchant: Merchant,
  asOf: Temporal.PlainDate,
  email: string,
  random: Random
): FixtureReceipt => {
  const monthsAgo = MONTHS - 1 - Math.floor(index / RECEIPTS_PER_MONTH);
  const month = asOf.subtract({ months: monthsAgo });
  // A receipt in the current month must not be dated after the anchor date.
  const lastDay = monthsAgo === 0 ? asOf.day : MONTH_DAY_LIMIT;
  const day = month.with({ day: 1 + Math.floor(random() * lastDay) });
  const hour = OPENING_HOUR + Math.floor(random() * OPENING_HOURS);
  const minute = Math.floor(random() * (60 / MINUTE_STEP)) * MINUTE_STEP;
  const transactionDateTime = receiptDateTimeToWallClock(
    `${day.toString()}T${pad(hour)}:${pad(minute)}`
  );

  const items = pickProducts(merchant, random).map((entry) =>
    productLine(entry, random)
  );
  const productCents = Math.round(
    items
      .filter((line) => line.kind === "product")
      .reduce((sum, line) => sum + line.lineTotal * 100, 0)
  );

  const paymentMethod = PAYMENT_METHODS[index % PAYMENT_METHODS.length];

  if (paymentMethod === "card" && index % 4 === 0) {
    const surchargeCents = Math.max(
      1,
      Math.round(productCents * CARD_SURCHARGE_RATE)
    );
    items.push({
      categorySlug: "card-surcharge",
      kind: "surcharge",
      lineTotal: toDollars(surchargeCents),
      name: "Card Surcharge",
      quantity: 1,
      unitPrice: toDollars(surchargeCents),
    });
  }

  if (index % 5 === 2) {
    const discountCents = -Math.max(
      1,
      Math.round(productCents * LOYALTY_DISCOUNT_RATE)
    );
    items.push({
      categorySlug: "loyalty-discount",
      kind: "discount",
      lineTotal: toDollars(discountCents),
      name: "Loyalty Discount",
      quantity: 1,
      unitPrice: toDollars(discountCents),
    });
  }

  // Every sixth receipt carries a line the taxonomy cannot place, so the chat's
  // "Uncategorised" row is populated without hand-editing a receipt later.
  if (index % 6 === 3) {
    const priceCents = jitterPrice(500, random);
    items.push({
      categorySlug: null,
      kind: "product",
      lineTotal: toDollars(priceCents),
      name: "Miscellaneous",
      quantity: 1,
      unitPrice: toDollars(priceCents),
    });
  }

  const itemsCents = Math.round(sumLineTotals(items) * 100);
  const isWarning = index === INTEGRITY_WARNING_INDEX;
  // The warned receipt states a total its line items do not reach, which is
  // exactly what `hasIntegrityWarning` records (ADR-0007, reconciliation).
  const totalCents = itemsCents + (isWarning ? INTEGRITY_GAP_CENTS : 0);
  const surchargeCents = Math.round(
    items
      .filter((line) => line.kind === "surcharge")
      .reduce((sum, line) => sum + line.lineTotal * 100, 0)
  );
  const subtotalCents = itemsCents - surchargeCents;
  const isAnonymous = index === ANONYMOUS_MERCHANT_INDEX;
  // ADR-0007: subtotal and GST are stored only on receipts that print them, so
  // half the corpus carries them and half leaves both null. On the receipts
  // that print them the fixture authors the values a printer would: the
  // subtotal is the product lines' sum (the surcharge prints separately) and GST
  // is the inclusive tax component of the total. Nothing is filled in for a
  // receipt the fixture records as not printing them.
  const printsTotalsBreakdown = index % 2 === 0;

  // `categorized_at` and `created_at` are instants (server events), so they
  // are derived from the wall clock rather than reusing it.
  const recordedAt = wallClockToInstant(transactionDateTime);

  return {
    categorizedAt: recordedAt,
    createdAt: recordedAt,
    gst: printsTotalsBreakdown ? toDollars(Math.round(totalCents / 11)) : null,
    hasIntegrityWarning: isWarning,
    id: fixtureUuid(email, `receipt:${index}`),
    items,
    merchantAbn: isAnonymous ? null : merchant.abn,
    merchantAddress: isAnonymous ? null : merchant.address,
    merchantName: isAnonymous ? null : merchant.name,
    merchantStoreId: isAnonymous ? null : merchant.storeId,
    paymentMethod,
    receiptNumber: `FIXTURE-${index + 1}`,
    status: "done",
    subtotal: printsTotalsBreakdown ? toDollars(subtotalCents) : null,
    total: toDollars(totalCents),
    transactionDateTime,
  };
};

/**
 * Builds the fixture corpus without touching the database.
 *
 * The email namespaces the deterministic ids, so two accounts can hold the same
 * fixture without colliding, and a re-run after a delete recreates the same
 * rows. `asOf` anchors the trailing twelve months; callers pass today so the
 * chat's "this year" questions always have data.
 *
 * Line items reconcile with the receipt total, except for the single receipt
 * flagged with an integrity warning — that pair is what the warning exists for.
 */
export const buildFixture = ({
  asOf,
  email,
}: {
  asOf: Temporal.PlainDate;
  email: string;
}): Fixture => {
  const normalizedEmail = email.trim().toLowerCase();
  const random = createRandom(FIXTURE_SEED);

  const baseDeck: Merchant[] = [];
  for (let index = 0; index < RECEIPT_COUNT; index += 1) {
    baseDeck.push(MERCHANTS[index % MERCHANTS.length]);
  }
  const merchantDeck = shuffle(baseDeck, random);

  const receipts = merchantDeck.map((merchant, index) =>
    buildReceipt(index, merchant, asOf, normalizedEmail, random)
  );

  return { asOf: asOf.toString(), email: normalizedEmail, receipts };
};
