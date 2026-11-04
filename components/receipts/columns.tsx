"use client";

import { createColumnHelper } from "@tanstack/react-table";
import type { SortFn } from "@tanstack/react-table";
import {
  BadgeAlert,
  Eye,
  FileCheck,
  MoreHorizontal,
  RefreshCw,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod/v4";

import { deleteReceipt } from "@/app/(app)/receipts/actions";
import type { DataTableFeatures } from "@/components/receipts/features";
import { dateRangeFilterFn } from "@/components/receipts/filters";
import { ReceiptStatus } from "@/components/receipts/receipt-status";
import { ReprocessDialog } from "@/components/receipts/reprocess-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import {
  compareWallClocks,
  formatReceiptDateTime,
} from "@/lib/receipt/datetime";

export const receiptTableSchema = z.object({
  hasIntegrityWarning: z.boolean(),
  id: z.string(),
  merchantName: z.string(),
  paymentMethod: z.string(),
  status: z.enum(["uploading", "pending", "processing", "done", "error"]),
  total: z.number(),
  transactionDateTime: z.string(),
});

export type ReceiptTable = z.infer<typeof receiptTableSchema>;

const columnHelper = createColumnHelper<DataTableFeatures, ReceiptTable>();

const RowActions = ({
  id,
  merchantName,
  status,
}: {
  id: string;
  merchantName: string;
  status: ReceiptTable["status"];
}) => {
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reprocessOpen, setReprocessOpen] = useState(false);

  // `processing` is offered as well as the finished states, because the claim
  // on a receipt mid-run expires: a run that was never created leaves the row
  // claimed with no other way back to it. The trigger decides whether the claim
  // is really free, so a click on a healthy run is refused rather than honoured.
  const canReprocess =
    status === "done" || status === "error" || status === "processing";

  const handleDelete = async () => {
    setDeleting(true);
    try {
      const result = await deleteReceipt(id);
      if (result.success) {
        setConfirmOpen(false);
        toast.add({ title: "Receipt deleted", type: "success" });
        router.refresh();
      } else {
        toast.add({
          description: result.error,
          title: "Delete failed",
          type: "error",
        });
      }
    } catch {
      toast.add({
        description: "Something went wrong deleting the receipt",
        title: "Delete failed",
        type: "error",
      });
    }
    setDeleting(false);
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label="Open row actions"
          render={<Button size="icon" variant="ghost" />}
        >
          <MoreHorizontal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<Link href={`/receipts/${id}`} />}>
            <Eye data-icon="inline-start" />
            View
          </DropdownMenuItem>
          {canReprocess ? (
            <DropdownMenuItem onClick={() => setReprocessOpen(true)}>
              <RefreshCw data-icon="inline-start" />
              Re-process
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 data-icon="inline-start" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete receipt?</DialogTitle>
            <DialogDescription>
              This will permanently remove the receipt
              {merchantName ? ` from ${merchantName}` : ""} and its image. This
              action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setConfirmOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={deleting}
              onClick={handleDelete}
              variant="destructive"
            >
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ReprocessDialog
        merchantName={merchantName}
        onOpenChange={setReprocessOpen}
        open={reprocessOpen}
        receiptId={id}
      />
    </>
  );
};

/**
 * Sorts the column by the wall clock's value, not its text.
 *
 * The built-in `datetime` sort compares anything that is not a `Date` as a
 * string, which is chronological only while every value shares one format: a
 * `T`-separated value sorts after every space-separated one on the same day,
 * because `" "` < `"T"`. Parsing makes the order independent of the separator,
 * so a value from a second producer cannot land at the wrong end of its day.
 */
const byWallClock: SortFn<DataTableFeatures, ReceiptTable> = (
  rowA,
  rowB,
  columnId
) =>
  compareWallClocks(
    String(rowA.getValue(columnId)),
    String(rowB.getValue(columnId))
  );

export const receiptColumns = columnHelper.columns([
  columnHelper.accessor("status", {
    cell: ({ row }) => (
      <ReceiptStatus id={row.original.id} status={row.original.status} />
    ),
    header: "Status",
    meta: { width: "11%" },
    sortFn: "alphanumeric",
  }),
  columnHelper.accessor("transactionDateTime", {
    // Left-aligned like every other cell: the column is a fixed share of the
    // table, so its text starts at a stable edge instead of drifting with the
    // width of the longest date on the page.
    // The value is the receipt's own wall clock, so the formatter renders it
    // as written: `formatReceiptDateTime` explains why it builds a `Date`
    // internally rather than handing a Temporal object to `Intl`.
    cell: ({ row }) => (
      <div className="truncate">
        {formatReceiptDateTime(row.original.transactionDateTime)}
      </div>
    ),
    filterFn: dateRangeFilterFn,
    header: "Date",
    meta: { width: "34%" },
    sortFn: byWallClock,
  }),
  columnHelper.accessor("merchantName", {
    cell: ({ row }) => (
      <div className="truncate">{row.original.merchantName}</div>
    ),
    filterFn: "includesString",
    header: "Merchant",
    sortFn: "alphanumeric",
  }),
  columnHelper.accessor("total", {
    cell: ({ row }) => {
      const { total } = row.original;
      const formattedAmount = new Intl.NumberFormat("en-AU", {
        currency: "AUD",
        style: "currency",
      }).format(total);

      return <div className="text-right font-medium">{formattedAmount}</div>;
    },
    header: "Total",
    meta: { width: "10%" },
  }),
  columnHelper.accessor("paymentMethod", {
    header: "Payment",
    meta: { width: "9%" },
    sortFn: "alphanumeric",
  }),
  columnHelper.accessor("hasIntegrityWarning", {
    cell: ({ row }) => {
      const { hasIntegrityWarning } = row.original;

      if (hasIntegrityWarning) {
        return (
          <Badge variant="destructive">
            <BadgeAlert data-icon="inline-start" />
            Integrity
          </Badge>
        );
      }

      return (
        <Badge className="text-center" variant="ghost">
          <FileCheck data-icon="inline-start" />
          Matching
        </Badge>
      );
    },
    header: "Integrity",
    meta: { width: "11%" },
  }),
  columnHelper.display({
    cell: ({ row }) => (
      <RowActions
        id={row.original.id}
        merchantName={row.original.merchantName}
        status={row.original.status}
      />
    ),
    header: "",
    id: "actions",
    meta: { width: "6%" },
  }),
]);
