"use client";

import { Badge } from "@/components/ui/badge";
import type { ReceiptState } from "@/lib/inngest/channels";

import type { ReceiptTable } from "./columns";
import { useReceiptState } from "./receipts-realtime-context";

type BadgeVariant = "default" | "destructive" | "secondary";

export interface StatusBadge {
  label: string;
  variant: BadgeVariant;
}

const statusBadgeVariant: Record<ReceiptTable["status"], BadgeVariant> = {
  done: "default",
  error: "destructive",
  pending: "secondary",
  processing: "secondary",
  uploading: "secondary",
};

/**
 * What a run in flight shows in place of the stored status.
 *
 * `failed` is labelled `error` so the badge does not rename itself: the refresh
 * that follows a terminal state re-reads the stored status, which says `error`,
 * and wording the live state `failed` would show two different words for one
 * outcome.
 */
const liveBadge: Record<ReceiptState, StatusBadge> = {
  done: { label: "done", variant: "default" },
  extracting: { label: "extracting", variant: "secondary" },
  failed: { label: "error", variant: "destructive" },
  storing: { label: "storing", variant: "secondary" },
};

/** The badge for a receipt: its run's stage while one reports, else its status. */
export const statusBadge = (
  status: ReceiptTable["status"],
  state: ReceiptState | null
): StatusBadge =>
  state
    ? liveBadge[state]
    : { label: status, variant: statusBadgeVariant[status] };

/**
 * A receipt's processing status, overlaid with the live stage of its run when
 * one is reporting.
 *
 * The stage comes from the page's single subscription to the owner's channel
 * (`ReceiptsRealtimeProvider`), routed here by receipt id — a row no longer owns
 * a stream of its own. That is what lets a table of queued receipts watch every
 * run without one subscription, token, and connection per row.
 */
export const ReceiptStatus = ({
  id,
  status,
}: {
  id: string;
  status: ReceiptTable["status"];
}) => {
  const state = useReceiptState(id)?.state ?? null;
  const badge = statusBadge(status, state);

  return <Badge variant={badge.variant}>{badge.label}</Badge>;
};
