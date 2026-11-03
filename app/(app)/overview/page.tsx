import { CategorySpendingChart } from "@/components/overview/category-spending-chart";
import { IntegrityChart } from "@/components/overview/integrity-chart";
import { MerchantSpendingChart } from "@/components/overview/merchant-spending-chart";
import { SpendingChart } from "@/components/overview/spending-chart";
import { requireSession } from "@/lib/auth/dal";
import { listOverviewReceipts } from "@/lib/db";
import { overviewWindow } from "@/lib/overview";
import { viewerToday } from "@/lib/viewer";

const OverviewPage = async () => {
  const session = await requireSession();

  // Resolved once, here: every chart and the query behind them answer "the
  // last 30 days" from the same day. A client component reading its own clock
  // would be server-rendered in the server's zone and hydrated in the
  // viewer's, which is a mismatch on every overview load for anyone else.
  const today = await viewerToday(session.user.timezone);
  const todayISO = today.toString();

  // One bounded query, carrying the line items with the receipts: the charts
  // aggregate it in the browser and each drill-down filters the same array, so
  // a panel's total is the bar's total by construction.
  const receipts = await listOverviewReceipts(
    session.user.id,
    overviewWindow(today)
  );

  return (
    <main className="container mx-auto flex flex-col gap-6 p-6">
      <h1 className="text-2xl font-bold">Overview</h1>
      <SpendingChart receipts={receipts} today={todayISO} />
      <CategorySpendingChart receipts={receipts} today={todayISO} />
      <div className="grid gap-6 lg:grid-cols-2">
        <MerchantSpendingChart receipts={receipts} today={todayISO} />
        <IntegrityChart receipts={receipts} />
      </div>
    </main>
  );
};

export default OverviewPage;
