import { describe, expect, it } from "vitest";

import type { ReceiptTable } from "@/components/receipts/columns";
import { statusBadge } from "@/components/receipts/receipt-status";
import type { ReceiptState } from "@/lib/inngest/channels";

describe(statusBadge, () => {
  it("shows the stored status when no run is reporting", () => {
    expect(statusBadge("done", null)).toStrictEqual({
      label: "done",
      variant: "default",
    });
  });

  it("shows the run's stage in place of the stored status", () => {
    expect(statusBadge("processing", "extracting")).toStrictEqual({
      label: "extracting",
      variant: "secondary",
    });
  });

  it("labels a failed run 'error', matching the status the row settles on", () => {
    // The refresh that follows a terminal state re-reads the stored status,
    // which says `error`. Labelling the live state `failed` would make the
    // badge change wording for the same outcome.
    expect(statusBadge("processing", "failed")).toStrictEqual({
      label: "error",
      variant: "destructive",
    });
  });

  it("falls back to the stored status when a stage has not arrived yet", () => {
    expect(statusBadge("processing", null)).toStrictEqual({
      label: "processing",
      variant: "secondary",
    });
  });

  it("marks a completed run done even before the table refreshes", () => {
    expect(statusBadge("processing", "done")).toStrictEqual({
      label: "done",
      variant: "default",
    });
  });

  it("covers every stored status, so a new one cannot go unstyled", () => {
    const statuses: ReceiptTable["status"][] = [
      "done",
      "error",
      "pending",
      "processing",
      "uploading",
    ];
    const stages: NonNullable<ReceiptState>[] = [
      "done",
      "extracting",
      "failed",
      "storing",
    ];

    for (const status of statuses) {
      expect(statusBadge(status, null).label).toBe(status);
    }

    for (const stage of stages) {
      expect(statusBadge("processing", stage).label).not.toBe("");
    }
  });
});
