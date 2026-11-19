import type { ReceiptState } from "@/lib/inngest/channels";

/** A run's stage split into "still going" and "the row changed on the server". */
export type StateTier = "active" | "terminal";

export const stateTier = (state: ReceiptState): StateTier =>
  state === "done" || state === "failed" ? "terminal" : "active";

export type RefreshNeed = "none" | "schedule";

/**
 * Whether a receipt's transition owes the page a server refresh.
 *
 * The live stage is rendered client-side from the message, so nothing needs a
 * refresh while a run is `extracting`/`storing`. Two transitions do:
 *
 * - **Terminal.** `done` means the run committed the stored row — status,
 *   totals, merchant, integrity — and the message carries the stage, not that
 *   data, so it has to be fetched. `failed` may have restored a previous
 *   status, so the stored badge can differ from what "error" implies.
 * - **A receipt not on the page starts.** Its row did not exist when the page
 *   rendered, so it takes one refresh to appear at all. Rows already rendered
 *   never need this — their badge overlays the live stage.
 *
 * Returning `none` for a repeated terminal means a receipt refreshes once per
 * completion, not once per message, and again only if it is re-processed.
 */
export const refreshForTransition = (
  previous: StateTier | undefined,
  state: ReceiptState,
  wasOnPage: boolean
): RefreshNeed => {
  if (stateTier(state) === "terminal") {
    return previous === "terminal" ? "none" : "schedule";
  }

  return previous === undefined && !wasOnPage ? "schedule" : "none";
};
