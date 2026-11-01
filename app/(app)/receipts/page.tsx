import { z } from "zod";

import { receiptColumns } from "@/components/receipts/columns";
import type { ReceiptTable } from "@/components/receipts/columns";
import { ReceiptsRealtimeProvider } from "@/components/receipts/receipts-realtime";
import { DataTable } from "@/components/receipts/table";
import { UploadFlow } from "@/components/upload-flow";
import { requireSession } from "@/lib/auth/dal";
import { listReceipts } from "@/lib/db";
import type { ReceiptSelect } from "@/lib/db/schema/receipt";
import { receiptSelectSchema } from "@/lib/db/schema/receipt";
import { instantToWallClock } from "@/lib/receipt/datetime";

const normalizeReceipt = (receipt: ReceiptSelect): ReceiptTable => ({
  hasIntegrityWarning: receipt.hasIntegrityWarning,
  id: receipt.id,
  merchantName: receipt.merchantName ?? "Unknown",
  paymentMethod: receipt.paymentMethod ?? "-",
  status: receipt.status as ReceiptTable["status"],
  total: receipt.total ?? 0,
  transactionDateTime:
    receipt.transactionDateTime ?? instantToWallClock(receipt.createdAt),
});

const getReceiptData = async (ownerId: string): Promise<ReceiptTable[]> => {
  const receipts = await listReceipts(ownerId);
  const parsed = receiptSelectSchema.array().safeParse(receipts);
  if (!parsed.success) {
    throw new Error(z.prettifyError(parsed.error));
  }
  const normalizedReceipts = parsed.data.map(normalizeReceipt);
  return normalizedReceipts;
};

const ReceiptsPage = async () => {
  const session = await requireSession();

  const receipts = await getReceiptData(session.user.id);

  return (
    <main className="container mx-auto flex flex-col gap-6 p-6">
      {/* The visible heading is the table's own; this one exists for screen
          readers and the document title. The greeting now lives on the chat,
          which is the front door. */}
      <h1 className="sr-only">Receipts</h1>
      <ReceiptsRealtimeProvider
        initialReceiptIds={receipts.map((receipt) => receipt.id)}
        userId={session.user.id}
      >
        <div className="flex justify-center">
          <UploadFlow />
        </div>
        {/* `contain: inline-size` stops the table's minimum width from being
            counted when the page sizes itself. The table is a flex item's
            descendant, and a flex item refuses to shrink below its contents by
            default — without this the `min-w` on the table pushed the section,
            and the whole page, wider than the window instead of scrolling
            inside the table's own container. */}
        <section className="mx-auto w-full [contain:inline-size]">
          <DataTable columns={receiptColumns} data={receipts} />
        </section>
      </ReceiptsRealtimeProvider>
    </main>
  );
};

export default ReceiptsPage;
