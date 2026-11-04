"use server";

import { eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { getSession } from "@/lib/auth/dal";
import { db, listCategoryOptions, receiptItems, receipts } from "@/lib/db";
import { receiptToFlat } from "@/lib/db/receipt-mapping";
import { reportError, USER_ERROR } from "@/lib/errors";
import { reconcile } from "@/lib/receipt/integrity";
import { normalizeLineItems } from "@/lib/receipt/line-item-money";
import { planLineItemChanges } from "@/lib/receipt/line-items";

import { updateReceiptSchema } from "./schema";
import type { UpdateReceiptInput } from "./schema";

export const updateReceipt = async (input: UpdateReceiptInput) => {
  const session = await getSession();

  if (!session) {
    return { error: USER_ERROR.unauthorized, success: false as const };
  }

  const parsed = updateReceiptSchema.safeParse(input);

  if (!parsed.success) {
    return { error: USER_ERROR.invalidInput, success: false as const };
  }

  const {
    items: submittedItems,
    merchant,
    payment,
    receiptId,
    totals,
    transaction,
  } = parsed.data;

  // A discount removes from the total, so the saved amount is coerced to the
  // negative line total the money model requires before it is reconciled or
  // written. A kind the user picked is not enough on its own.
  const items = normalizeLineItems(submittedItems);

  const existing = await db.query.receipts.findFirst({
    where: { id: receiptId, userId: session.user.id },
    with: { receiptItems: true },
  });

  if (!existing || existing.status !== "done") {
    return { error: USER_ERROR.receiptNotEditable, success: false as const };
  }

  // Categories are bounded by the taxonomy: a submitted id that is not a leaf
  // category is rejected rather than stored, so a manual edit cannot introduce
  // a classification the rest of the app would not recognise.
  const categoryIds = items.flatMap((item) =>
    item.categoryId ? [item.categoryId] : []
  );
  if (categoryIds.length > 0) {
    const options = await listCategoryOptions();
    const leafIds = new Set(options.map((option) => option.id));
    if (categoryIds.some((categoryId) => !leafIds.has(categoryId))) {
      return { error: USER_ERROR.invalidInput, success: false as const };
    }
  }

  const plan = planLineItemChanges(
    existing.receiptItems.map((item) => ({
      categoryId: item.categoryId,
      categorySource: item.categorySource,
      id: item.id,
    })),
    items
  );

  const hasIntegrityWarning = !reconcile(items, totals).matches;

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(receipts)
        .set({
          ...receiptToFlat({ merchant, payment, totals, transaction }),
          hasIntegrityWarning,
        })
        .where(eq(receipts.id, receiptId));

      await Promise.all(
        plan.updates.map((change) =>
          tx
            .update(receiptItems)
            .set(change.values)
            .where(eq(receiptItems.id, change.id))
        )
      );

      if (plan.inserts.length > 0) {
        await tx
          .insert(receiptItems)
          .values(plan.inserts.map((values) => ({ ...values, receiptId })));
      }

      if (plan.removals.length > 0) {
        await tx
          .delete(receiptItems)
          .where(inArray(receiptItems.id, plan.removals));
      }
    });
  } catch (error) {
    reportError("receipts.update", error);
    return { error: USER_ERROR.saveFailed, success: false as const };
  }

  revalidatePath(`/receipts/${receiptId}`);

  return { success: true as const };
};
