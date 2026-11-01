import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  numeric,
  snakeCase,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-orm/zod";
import { z } from "zod";

import { user } from "@/lib/db/schema/auth";

export const processingStatusEnum = z.enum([
  "uploading",
  "pending",
  "processing",
  "done",
  "error",
]);

export type ProcessingStatus = z.infer<typeof processingStatusEnum>;

export const merchantSchema = z.strictObject({
  abn: z.string().optional(),
  address: z.string().optional(),
  name: z.string(),
  storeId: z.string().optional(),
});
export type Merchant = z.infer<typeof merchantSchema>;

export const transactionSchema = z.strictObject({
  datetime: z.string().optional(),
  receiptNumber: z.string().optional(),
});
export type Transaction = z.infer<typeof transactionSchema>;

export const totalsSchema = z.strictObject({
  gst: z.number().optional(),
  subtotal: z.number().optional(),
  total: z.number(),
});
export type Totals = z.infer<typeof totalsSchema>;

export const paymentMethodEnum = z.enum(["cash", "card", "other"]);
export type PaymentMethod = z.infer<typeof paymentMethodEnum>;

export const paymentSchema = z.strictObject({
  method: paymentMethodEnum.default("other"),
});
export type Payment = z.infer<typeof paymentSchema>;

export const receipts = snakeCase.table(
  "receipts",
  {
    categorizedAt: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    gst: numeric({ mode: "number", precision: 10, scale: 2 }),
    hasIntegrityWarning: boolean().notNull().default(false),
    id: uuid().primaryKey().defaultRandom(),
    merchantAbn: text(),
    merchantAddress: text(),
    merchantName: text(),
    merchantStoreId: text(),
    objectKey: text(),
    paymentMethod: text().$type<PaymentMethod>(),
    /**
     * When the current run claimed the receipt.
     *
     * Stamped where a run takes the row into `processing`: the action's claim
     * for a re-process, and `mark-processing` for any run that gets that far. A
     * `pending` receipt therefore has no stamp — it is queued, not claimed, and
     * `reprocessReceipt` deliberately does not take one over.
     *
     * A claim has no other way to expire. The run that owes the receipt may
     * never be created at all — an event is accepted when no function matches
     * it — and nothing else moves the row out of `processing`, so without this
     * an abandoned claim is a dead end reachable only by editing the database.
     */
    processingStartedAt: timestamp({ withTimezone: true }),
    receiptNumber: text(),
    status: text().$type<ProcessingStatus>().notNull().default("pending"),
    subtotal: numeric({ mode: "number", precision: 10, scale: 2 }),
    total: numeric({ mode: "number", precision: 10, scale: 2 }),
    /**
     * The local date and time printed on the receipt — a wall clock, not an
     * instant. Stored without a time zone and read as the raw Postgres text
     * (`2026-10-07 20:30:00`), which `lib/receipt/datetime.ts` parses with
     * `Temporal`. `mode: "date"` would have pg rebuild a `Date` in the Node
     * process's own zone, reintroducing the conversion this column avoids.
     */
    transactionDateTime: timestamp("transaction_datetime", {
      mode: "string",
    }),
    transcript: text(),
    userId: text()
      .notNull()
      .references(() => user.id),
  },
  (table) => [
    index("receipts_merchant_name_lower_idx").using(
      "btree",
      sql`lower(${table.merchantName})`
    ),
    index("receipts_transaction_datetime_index").on(table.transactionDateTime),
    index("receipts_created_at_index").on(table.createdAt),
    index("receipts_payment_method_index").on(table.paymentMethod),
    index("receipts_user_id_index").on(table.userId),
  ]
);

export const receiptSelectSchema = createSelectSchema(receipts);
export const receiptInsertSchema = createInsertSchema(receipts, {
  paymentMethod: paymentMethodEnum.nullable().optional(),
  status: processingStatusEnum.optional(),
});
export const receiptUpdateSchema = createUpdateSchema(receipts);

export type ReceiptSelect = z.infer<typeof receiptSelectSchema>;
export type ReceiptInsert = z.infer<typeof receiptInsertSchema>;
export type ReceiptUpdate = z.infer<typeof receiptUpdateSchema>;

export const receiptNestedSchema = z.object({
  merchant: merchantSchema,
  payment: paymentSchema,
  totals: totalsSchema,
  transaction: transactionSchema,
});
export type ReceiptNested = z.infer<typeof receiptNestedSchema>;
