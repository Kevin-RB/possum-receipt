import { and, eq, gte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import "temporal-polyfill/global";

import { relations } from "@/lib/db/relations";
import { categories as categoriesTable } from "@/lib/db/schema/category";
import { receipts as receiptsTable } from "@/lib/db/schema/receipt";
import { receiptItems as receiptItemsTable } from "@/lib/db/schema/receipt-item";
import { RECEIPT_TIMEZONE } from "@/lib/receipt/datetime";

import { DEFAULT_DATABASE_URL } from "./constants";

export { categories } from "./schema/category";
export type { CategorySelect } from "./schema/category";
export { receiptItems } from "./schema/receipt-item";
export { receipts } from "./schema/receipt";
export type { ProcessingStatus } from "./schema/receipt";

const createDb = (connectionString: string) => {
  const pool = new Pool({
    application_name: "receipt-app",
    connectionString,
    max: 10,
  });
  return drizzle({ client: pool, relations });
};

export type DrizzleDb = ReturnType<typeof createDb>;

const globalForDb = globalThis as unknown as { db?: DrizzleDb };

export const db =
  globalForDb.db ?? createDb(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}

export const findReceiptByIdForOwner = (id: string, ownerId: string) =>
  db.query.receipts.findFirst({ where: { id, userId: ownerId } });

export const findReceiptByIdWithItems = (id: string, ownerId: string) =>
  db.query.receipts.findFirst({
    where: { id, userId: ownerId },
    with: { receiptItems: true },
  });

export const findReceiptByObjectKey = (objectKey: string) =>
  db.query.receipts.findFirst({ where: { objectKey } });

/**
 * The receipts list. Receipt-level columns only: the table does not read line
 * items, so loading them here was a second query for rows that the page
 * dropped. `/receipts/[id]` uses `findReceiptByIdWithItems` when it needs them.
 */
export const listReceipts = (ownerId: string) =>
  db.query.receipts.findMany({
    orderBy: (table, { desc: orderDesc }) => [orderDesc(table.createdAt)],
    where: { userId: ownerId },
  });

export const listDoneReceipts = (ownerId: string) =>
  db.query.receipts.findMany({
    orderBy: (table, { desc: orderDesc }) => [orderDesc(table.createdAt)],
    where: { status: "done", userId: ownerId },
  });

export interface CategoryOption {
  id: string;
  name: string;
  parentName: string | null;
  slug: string;
}

export const listCategoryOptions = async (): Promise<CategoryOption[]> => {
  const all = await db.select().from(categoriesTable);
  const byId = new Map(all.map((category) => [category.id, category]));
  const parentIds = new Set(
    all
      .map((category) => category.parentId)
      .filter((id): id is string => id !== null)
  );

  return all
    .filter((category) => !parentIds.has(category.id))
    .map((category) => ({
      id: category.id,
      name: category.name,
      parentName: category.parentId
        ? (byId.get(category.parentId)?.name ?? null)
        : null,
      slug: category.slug,
    }));
};

export interface CategorySpendDay {
  categoryName: string;
  date: string;
  slug: string;
  total: number;
}

const categoryDayExpression = sql`(${receiptsTable.transactionDateTime})::date`;

export const spendByCategoryByDay = async (
  ownerId: string,
  days: number
): Promise<CategorySpendDay[]> => {
  // Whole calendar days, inclusive of today. The stored value is already the
  // receipt's local wall clock, so the day is the date part — no timezone
  // conversion, and no rolling 24-hour window that would start at whatever
  // time it happens to be now.
  const today = Temporal.Now.plainDateISO(RECEIPT_TIMEZONE);
  const start = today.subtract({ days: days - 1 });

  return await db
    .select({
      categoryName: sql<string>`coalesce(${categoriesTable.name}, 'Uncategorised')`,
      date: sql<string>`${categoryDayExpression}`,
      slug: sql<string>`coalesce(${categoriesTable.slug}, 'uncategorised')`,
      total: sql<number>`sum(${receiptItemsTable.lineTotal})::double precision`,
    })
    .from(receiptItemsTable)
    .innerJoin(receiptsTable, eq(receiptItemsTable.receiptId, receiptsTable.id))
    .leftJoin(
      categoriesTable,
      eq(receiptItemsTable.categoryId, categoriesTable.id)
    )
    .where(
      and(
        eq(receiptsTable.userId, ownerId),
        eq(receiptsTable.status, "done"),
        eq(receiptItemsTable.kind, "product"),
        gte(receiptsTable.transactionDateTime, `${start.toString()} 00:00:00`)
      )
    )
    .groupBy(
      categoriesTable.id,
      categoriesTable.name,
      categoriesTable.slug,
      categoryDayExpression
    );
};

export { drizzle } from "drizzle-orm/node-postgres";
