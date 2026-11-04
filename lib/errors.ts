/**
 * The app's error vocabulary: every string here is written for a person, and
 * these are the only strings the UI may show. A cause, an HTTP status line, a
 * provider message and a stack trace never are.
 *
 * Expected failures are **returned**, not thrown. Next redacts an error thrown
 * in a Server Component in production — `error.message` becomes a generic
 * string and the cause is reachable only as `error.digest` in the server log —
 * so a message carried on a thrown `Error` cannot reach the UI from the server.
 * Every server boundary returns a code from this catalogue instead, and logs
 * the cause with `reportError`. See ADR-0014.
 */
export const USER_ERROR = {
  deleteFailed: "Failed to delete receipt",
  /** Nothing more specific is known, or the cause is not ours to describe. */
  generic: "Something went wrong. Please try again.",
  invalidInput: "Validation failed",
  modelNotAvailable: "That model is not available",
  modelServerUnreachable: "The model server is not reachable",
  modelUnavailable:
    "The assistant's model isn't responding right now. Please try again in a moment.",
  notFound: "Receipt not found",
  receiptNotEditable: "Receipt is not editable",
  reprocessFailed: "Failed to start re-processing",
  reprocessInFlight: "Receipt is already being processed",
  reprocessNoImage: "Receipt has no image to re-process",
  reprocessNotReady: "Receipt is not ready to re-process",
  saveFailed: "Failed to save receipt",
  unauthorized: "Your session has expired. Please sign in again.",
  uploadFailed: "The upload failed. Please try again.",
} as const;

export type UserErrorCode = keyof typeof USER_ERROR;

const USER_MESSAGES: ReadonlySet<string> = new Set(Object.values(USER_ERROR));

/**
 * Whether a string arrived from this app rather than from underneath it.
 *
 * Used where text crosses a boundary the app does not fully own — a chat error
 * chunk, a failed fetch body — so that only wording from the catalogue is
 * shown. Everything else collapses to `generic`.
 */
export const isUserMessage = (text: string): boolean => USER_MESSAGES.has(text);

/**
 * Log the cause on the server: one convention, so failures are greppable by
 * the boundary that failed (`[chat]`, `[receipts.delete]`) rather than only by
 * an error message that may itself be the thing that is wrong.
 *
 * Logging belongs here, not at the UI: a cause is raw material for whoever
 * debugs the deployment, and it is exactly what must not be sent to a browser.
 */
export const reportError = (scope: string, error: unknown): void => {
  console.error(`[${scope}]`, error);
};
