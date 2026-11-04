import { and, desc, eq, gte, ilike, lt, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import "temporal-polyfill/global";

import {
  categories,
  db,
  findReceiptByIdWithItems,
  receiptItems,
  receipts,
} from "@/lib/db";
import { formatReceiptDate, wallClockToISODate } from "@/lib/receipt/datetime";

import type {
  CategorySpend,
  LineItemSearch,
  MerchantSpend,
  ReceiptDetail,
  ReceiptSummary,
} from "./output-schemas";

const SEARCH_LIMIT = 25;
const LIST_LIMIT = 20;

const roundToCents = (value: number): number => Math.round(value * 100) / 100;

/**
 * The bounds of an inclusive calendar day, in the column's wall-clock format.
 * The stored value is already the receipt's local time, so a day is a string
 * comparison — no timezone conversion and no instant arithmetic.
 */
export const startOfReceiptDay = (isoDate: string): string =>
  `${isoDate} 00:00:00`;

export const startOfNextReceiptDay = (isoDate: string): string =>
  `${Temporal.PlainDate.from(isoDate).add({ days: 1 }).toString()} 00:00:00`;

const escapeLike = (value: string): string =>
  value.replaceAll(/[%_\\]/gu, "\\$&");

const optionalDateFilters = (from?: string, to?: string) => {
  const filters = [];
  if (from) {
    filters.push(gte(receipts.transactionDateTime, startOfReceiptDay(from)));
  }
  if (to) {
    filters.push(lt(receipts.transactionDateTime, startOfNextReceiptDay(to)));
  }
  return filters;
};

/**
 * How `spendByCategory` rolls its rows up. `subcategory` is the leaf taxonomy
 * a line item is actually assigned; `category` rolls each leaf up to its
 * top-level parent, so a question about a whole group ("how much on
 * Groceries?") is answered by the query rather than by the model adding
 * subcategory rows up.
 */
export type CategorySpendGroupBy = "subcategory" | "category";

export interface CategorySpendQuery {
  /**
   * Narrows to one branch of the taxonomy: a top-level name ("Health") selects
   * that whole subtree, a leaf name ("Pharmacy") selects the single leaf.
   */
  category?: string;
  groupBy?: CategorySpendGroupBy;
}

export const spendByCategory = async (
  ownerId: string,
  from: string,
  to: string,
  { category, groupBy = "subcategory" }: CategorySpendQuery = {}
): Promise<CategorySpend> => {
  const parentCategories = alias(categories, "parent_categories");

  // A leaf rolls up to its parent's name; a leaf that is already top-level has
  // no parent and so rolls up to itself; an uncategorised line has neither and
  // falls to the placeholder.
  const topLevelName = sql<string>`coalesce(${parentCategories.name}, ${categories.name}, 'Uncategorised')`;
  const groupLabel =
    groupBy === "category"
      ? topLevelName
      : sql<string>`coalesce(${categories.name}, 'Uncategorised')`;

  const rows = await db
    .select({
      category: groupLabel,
      total: sql<number>`sum(${receiptItems.lineTotal})::double precision`,
    })
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .leftJoin(categories, eq(receiptItems.categoryId, categories.id))
    .leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))
    .where(
      and(
        eq(receipts.userId, ownerId),
        eq(receipts.status, "done"),
        eq(receiptItems.kind, "product"),
        gte(receipts.transactionDateTime, startOfReceiptDay(from)),
        lt(receipts.transactionDateTime, startOfNextReceiptDay(to)),
        category
          ? or(eq(topLevelName, category), eq(categories.name, category))
          : undefined
      )
    )
    .groupBy(groupLabel)
    .orderBy(desc(sql`sum(${receiptItems.lineTotal})`));

  return {
    categories: rows,
    total: roundToCents(rows.reduce((sum, row) => sum + row.total, 0)),
  };
};

export const spendByMerchant = async (
  ownerId: string,
  from: string,
  to: string
): Promise<MerchantSpend> => {
  const rows = await db
    .select({
      merchant: sql<string>`coalesce(${receipts.merchantName}, 'Unknown')`,
      receipts: sql<number>`count(*)::int`,
      total: sql<number>`sum(${receipts.total})::double precision`,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.userId, ownerId),
        eq(receipts.status, "done"),
        gte(receipts.transactionDateTime, startOfReceiptDay(from)),
        lt(receipts.transactionDateTime, startOfNextReceiptDay(to))
      )
    )
    .groupBy(receipts.merchantName)
    .orderBy(desc(sql`sum(${receipts.total})`));

  return {
    merchants: rows,
    total: roundToCents(rows.reduce((sum, row) => sum + row.total, 0)),
  };
};

const FUZZY_SIMILARITY_THRESHOLD = 0.4;

interface SearchRow {
  category: string | null;
  date: string | null;
  item: string;
  kind: string;
  lineTotal: number;
  merchant: string | null;
  receiptId: string;
}

const searchSelection = {
  category: categories.name,
  date: receipts.transactionDateTime,
  item: receiptItems.name,
  kind: receiptItems.kind,
  lineTotal: receiptItems.lineTotal,
  merchant: receipts.merchantName,
  receiptId: receipts.id,
};

const toLineItemSearch = (items: SearchRow[]): LineItemSearch => {
  let total = 0;
  for (const item of items) {
    if (item.kind === "product") {
      total += item.lineTotal;
    }
  }

  return {
    count: items.length,
    items: items.map((item) => ({
      ...item,
      date: item.date ? wallClockToISODate(item.date) : null,
      dateLabel: item.date ? formatReceiptDate(item.date) : null,
    })),
    total: roundToCents(total),
  };
};

export const searchLineItems = async (
  ownerId: string,
  { from, query, to }: { from?: string; query: string; to?: string }
): Promise<LineItemSearch> => {
  const filters = [
    eq(receipts.userId, ownerId),
    eq(receipts.status, "done"),
    ...optionalDateFilters(from, to),
  ];

  const exact = await db
    .select(searchSelection)
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .leftJoin(categories, eq(receiptItems.categoryId, categories.id))
    .where(and(...filters, ilike(receiptItems.name, `%${escapeLike(query)}%`)))
    .orderBy(desc(receipts.transactionDateTime))
    .limit(SEARCH_LIMIT);

  if (exact.length > 0) {
    return toLineItemSearch(exact);
  }

  // Receipt names are abbreviated and often misspelt — "Greek Yoghurt" for
  // "yogurt", "COLES COT CHEESE" for "cottage cheese" — so a literal substring
  // search can miss a product the user knows they bought. Fall back to trigram
  // word similarity, closest first, but only when the literal search found
  // nothing: a successful exact search must not gain fuzzy noise.
  const similarity = sql<number>`word_similarity(${query}, ${receiptItems.name})`;
  const fuzzy = await db
    .select(searchSelection)
    .from(receiptItems)
    .innerJoin(receipts, eq(receiptItems.receiptId, receipts.id))
    .leftJoin(categories, eq(receiptItems.categoryId, categories.id))
    .where(and(...filters, sql`${similarity} >= ${FUZZY_SIMILARITY_THRESHOLD}`))
    .orderBy(desc(similarity), desc(receipts.transactionDateTime))
    .limit(SEARCH_LIMIT);

  return toLineItemSearch(fuzzy);
};

export const listReceiptSummaries = async (
  ownerId: string,
  { from, merchant, to }: { from?: string; merchant?: string; to?: string }
): Promise<ReceiptSummary[]> => {
  const rows = await db
    .select({
      date: receipts.transactionDateTime,
      hasIntegrityWarning: receipts.hasIntegrityWarning,
      id: receipts.id,
      merchant: receipts.merchantName,
      total: receipts.total,
    })
    .from(receipts)
    .where(
      and(
        eq(receipts.userId, ownerId),
        eq(receipts.status, "done"),
        merchant
          ? ilike(receipts.merchantName, `%${escapeLike(merchant)}%`)
          : undefined,
        ...optionalDateFilters(from, to)
      )
    )
    .orderBy(desc(receipts.transactionDateTime))
    .limit(LIST_LIMIT);
  return rows.map((row) => ({
    ...row,
    date: row.date ? wallClockToISODate(row.date) : null,
    dateLabel: row.date ? formatReceiptDate(row.date) : null,
  }));
};

export const receiptDetail = async (
  ownerId: string,
  receiptId: string
): Promise<ReceiptDetail | null> => {
  const receipt = await findReceiptByIdWithItems(receiptId, ownerId);
  if (!receipt) {
    return null;
  }

  return {
    date: receipt.transactionDateTime
      ? wallClockToISODate(receipt.transactionDateTime)
      : null,
    dateLabel: receipt.transactionDateTime
      ? formatReceiptDate(receipt.transactionDateTime)
      : null,
    gst: receipt.gst,
    id: receipt.id,
    items: receipt.receiptItems.map((item) => ({
      kind: item.kind,
      lineTotal: item.lineTotal,
      name: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
    })),
    merchant: receipt.merchantName,
    paymentMethod: receipt.paymentMethod,
    subtotal: receipt.subtotal,
    total: receipt.total,
  };
};
