import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import "temporal-polyfill/global";

import { relations } from "@/lib/db/relations";
import { categories as categoriesTable } from "@/lib/db/schema/category";
import type { OverviewReceipt, Window } from "@/lib/overview";

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

/**
 * The overview's corpus: every done receipt in the window, with its line items
 * and their categories, in one bounded query.
 *
 * One query rather than a per-chart aggregate, because the charts and their
 * drill-downs must agree on what a bar was summed from. The page passes the
 * widest window any chart can show, on both ends — a receipt dated in the
 * future is no more part of "the last twelve months" than an old one — so
 * loading the overview never ships the whole receipt history.
 */
export const listOverviewReceipts = async (
  ownerId: string,
  window: Window
): Promise<OverviewReceipt[]> => {
  const receipts = await db.query.receipts.findMany({
    columns: {
      hasIntegrityWarning: true,
      id: true,
      merchantName: true,
      total: true,
      transactionDateTime: true,
    },
    orderBy: (table, { desc: orderDesc }) => [
      orderDesc(table.transactionDateTime),
    ],
    where: {
      status: "done",
      transactionDateTime: {
        gte: `${window.start.toString()} 00:00:00`,
        lte: `${window.end.toString()} 23:59:59`,
      },
      userId: ownerId,
    },
    with: {
      receiptItems: {
        columns: { id: true, kind: true, lineTotal: true, name: true },
        with: { category: { columns: { name: true, slug: true } } },
      },
    },
  });

  return receipts.map(({ receiptItems, ...receipt }) => ({
    ...receipt,
    items: receiptItems.map(({ category, ...item }) => ({
      ...item,
      categoryName: category?.name ?? null,
      categorySlug: category?.slug ?? null,
    })),
  }));
};

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

export { drizzle } from "drizzle-orm/node-postgres";
