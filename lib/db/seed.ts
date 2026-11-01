import { randomUUID } from "node:crypto";

import { ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { reset, seed } from "drizzle-seed";
import { Pool } from "pg";

import { DEFAULT_SEED_DATABASE_URL } from "@/lib/db/constants";
import { user } from "@/lib/db/schema/auth";
import { receipts } from "@/lib/db/schema/receipt";
import { receiptItems } from "@/lib/db/schema/receipt-item";

const seedDatabaseUrl =
  process.env.SEED_DATABASE_URL ?? DEFAULT_SEED_DATABASE_URL;

const seedNumber = 20_260_817;

const seedDb = drizzle({
  client: new Pool({
    application_name: "receipt-app-seed",
    connectionString: seedDatabaseUrl,
  }),
});

const merchants = [
  "Coles",
  "Woolworths",
  "Aldi",
  "IGA",
  "Bunnings",
  "7-Eleven",
  "Kmart",
  "Chemist Warehouse",
];

const addresses = [
  "123 Smith St, Fitzroy VIC 3065",
  "45 Swanston St, Melbourne VIC 3000",
  "88 Lygon St, Carlton VIC 3053",
  "15 Boundary Rd, North Melbourne VIC 3051",
  "2/99 Chapel St, Windsor VIC 3181",
  "330 Edward St, Brisbane QLD 4000",
  "71 Gladstone Rd, Highgate Hill QLD 4101",
  "18 Stanley St, South Brisbane QLD 4101",
];

const abns = [
  "93 111 222 333",
  "61 078 402 371",
  "81 004 126 018",
  "43 619 298 123",
  "74 090 459 029",
  "21 600 152 084",
  "80 005 401 523",
  "52 173 992 002",
];

const storeIds = [
  "0342",
  "4570",
  "1108",
  "2234",
  "7789",
  "0612",
  "3905",
  "8440",
];

const receiptNumbers = [
  "0342-0087-1234",
  "4570-0122-8765",
  "1108-0310-5566",
  "2234-0077-9911",
  "7789-0150-3322",
  "0612-0241-7788",
  "3905-0088-4455",
  "8440-0112-6677",
];

const paymentMethods = ["card", "cash", "other"];

const groceryItems = [
  "Milk 2L",
  "Bread",
  "Apples 1kg",
  "Bananas",
  "Free-range Eggs 12",
  "Chicken Breast 500g",
  "Cheddar 250g",
  "Pasta 500g",
  "Basmati Rice 1kg",
  "Orange Juice 1L",
  "Coffee Beans 250g",
  "Cereal 500g",
  "Greek Yoghurt 1kg",
  "Tomatoes",
  "Cucumber",
  "Potatoes 2kg",
  "Olive Oil 750ml",
  "Butter 250g",
  "Tea Bags 100",
  "Dish Soap 500ml",
];

const OWNER_EMAIL = "kr38996@gmail.com";

await reset(seedDb, { receiptItems, receipts, user });

const [owner] = await seedDb
  .insert(user)
  .values({
    email: OWNER_EMAIL,
    id: randomUUID(),
    name: "Kevin",
  })
  .returning();

await seed(
  seedDb,
  { receiptItems, receipts, user },
  { seed: seedNumber }
).refine((f) => ({
  receiptItems: {
    columns: {
      lineTotal: f.number({ maxValue: 60, minValue: 0.5, precision: 100 }),
      name: f.valuesFromArray({ values: groceryItems }),
      quantity: f.int({ maxValue: 4, minValue: 1 }),
      unitPrice: f.number({ maxValue: 20, minValue: 0.5, precision: 100 }),
    },
  },
  receipts: {
    columns: {
      gst: f.number({ maxValue: 8, minValue: 0, precision: 100 }),
      merchantAbn: f.valuesFromArray({ values: abns }),
      merchantAddress: f.valuesFromArray({ values: addresses }),
      merchantName: f.valuesFromArray({ values: merchants }),
      merchantStoreId: f.valuesFromArray({ values: storeIds }),
      objectKey: false,
      paymentMethod: f.valuesFromArray({ values: paymentMethods }),
      receiptNumber: f.valuesFromArray({ values: receiptNumbers }),
      status: f.default({ defaultValue: "done" }),
      subtotal: f.number({ maxValue: 80, minValue: 5, precision: 100 }),
      total: f.number({ maxValue: 90, minValue: 5, precision: 100 }),
      transactionDateTime: f.valuesFromArray({
        values: [
          "2026-01-08T09:15:00",
          "2026-01-21T18:40:00",
          "2026-02-03T12:05:00",
          "2026-02-19T20:30:00",
          "2026-03-07T08:55:00",
          "2026-03-24T17:10:00",
          "2026-04-11T13:25:00",
          "2026-04-28T19:45:00",
          "2026-05-14T10:35:00",
          "2026-06-02T16:20:00",
          "2026-07-09T11:50:00",
          "2026-08-15T14:05:00",
        ],
      }),
    },
    count: 8,
    with: {
      receiptItems: [
        { count: [2, 3], weight: 0.4 },
        { count: [4, 5], weight: 0.4 },
        { count: [6, 8], weight: 0.2 },
      ],
    },
  },
}));

await seedDb.update(receipts).set({ userId: owner.id });

await seedDb.delete(user).where(ne(user.id, owner.id));

process.stdout.write(`Seeded demo data into ${seedDatabaseUrl}\n`);

await seedDb.$client.end();
