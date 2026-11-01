import { z } from "zod";

import { CategorySpendingChart } from "@/components/overview/category-spending-chart";
import { IntegrityChart } from "@/components/overview/integrity-chart";
import { MerchantSpendingChart } from "@/components/overview/merchant-spending-chart";
import { SpendingChart } from "@/components/overview/spending-chart";
import { requireSession } from "@/lib/auth/dal";
import { listDoneReceipts, spendByCategoryByDay } from "@/lib/db";
import { receiptSelectSchema } from "@/lib/db/schema/receipt";
import type { ReceiptSelect } from "@/lib/db/schema/receipt";
import { viewerToday } from "@/lib/viewer";

const CATEGORY_HISTORY_DAYS = 95;

const getReceipts = async (ownerId: string): Promise<ReceiptSelect[]> => {
  const receipts = await listDoneReceipts(ownerId);
  const parsed = receiptSelectSchema.array().safeParse(receipts);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  return parsed.data;
};

const OverviewPage = async () => {
  const session = await requireSession();

  // Resolved once, here: every chart and the query behind them answer "the
  // last 30 days" from the same day. A client component reading its own clock
  // would be server-rendered in the server's zone and hydrated in the
  // viewer's, which is a mismatch on every overview load for anyone else.
  const today = await viewerToday(session.user.timezone);
  const todayISO = today.toString();

  const [receipts, categorySpend] = await Promise.all([
    getReceipts(session.user.id),
    spendByCategoryByDay(session.user.id, CATEGORY_HISTORY_DAYS, today),
  ]);

  return (
    <main className="container mx-auto flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">Overview</h1>
      <SpendingChart
        receipts={receipts.map(({ total, transactionDateTime }) => ({
          total,
          transactionDateTime,
        }))}
        today={todayISO}
      />
      <CategorySpendingChart rows={categorySpend} today={todayISO} />
      <div className="grid gap-6 lg:grid-cols-2">
        <MerchantSpendingChart
          receipts={receipts.map(
            ({ total, transactionDateTime, merchantName }) => ({
              merchantName,
              total,
              transactionDateTime,
            })
          )}
        />
        <IntegrityChart
          receipts={receipts.map(({ hasIntegrityWarning }) => ({
            hasIntegrityWarning,
          }))}
        />
      </div>
    </main>
  );
};

export default OverviewPage;
