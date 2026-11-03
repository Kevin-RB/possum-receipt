import { defineRelations } from "drizzle-orm";

import { categories } from "@/lib/db/schema/category";
import { receipts } from "@/lib/db/schema/receipt";
import { receiptItems } from "@/lib/db/schema/receipt-item";

export const relations = defineRelations(
  { categories, receiptItems, receipts },
  (r) => ({
    receiptItems: {
      category: r.one.categories({
        from: r.receiptItems.categoryId,
        to: r.categories.id,
      }),
      receipt: r.one.receipts({
        from: r.receiptItems.receiptId,
        to: r.receipts.id,
      }),
    },
    receipts: {
      receiptItems: r.many.receiptItems(),
    },
  })
);
