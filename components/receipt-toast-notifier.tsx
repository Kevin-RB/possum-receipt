"use client";

import { useEffect, useRef } from "react";

import { toast } from "@/components/ui/toast";
import { isUserMessage, USER_ERROR } from "@/lib/errors";
import type { ReceiptState } from "@/lib/inngest/channels";

/** What a toast says, and how long it stays. */
export interface ToastBody {
  description: string;
  timeout: number;
  title: string;
  type: "error" | "success";
}

/**
 * The stage the upload card shows while the run is in flight. Deliberately not
 * a live region: progress you can read on the page you are already on does not
 * need announcing, and the button keeps focus, so the stage travels with it.
 */
export const resolveProgressLabel = (state?: ReceiptState): string => {
  switch (state) {
    case "storing": {
      return "Engraving data in stone…";
    }
    case "extracting": {
      return "Gnomes are extracting data…";
    }
    case "parsing": {
      return "A magic cat is taking a look at your receipt…";
    }
    default: {
      return "Waiting for the server…";
    }
  }
};

/**
 * What, if anything, the reader should be told right now.
 *
 * Both error strings here cross a boundary the app does not own: `error` comes
 * from the realtime transport and `stateError` from the stored result of an
 * Inngest run. Either may be a provider message, a stack line or a status
 * code, so only catalogue wording is passed through; the rest collapses to
 * `USER_ERROR.generic`. See ADR-0014.
 */
export const resolveToastBody = (input: {
  error: Error | null;
  state: ReceiptState | undefined;
  stateError: string | undefined;
}): ToastBody | null => {
  const { error, state, stateError } = input;

  // A socket drop must not replace a toast that already reports the outcome:
  // once the receipt is done or failed, the stored result is what the owner
  // needs to see, not a sticky connection error about a run that finished.
  if (error && state !== "done" && state !== "failed") {
    return {
      description: isUserMessage(error.message)
        ? error.message
        : USER_ERROR.generic,
      timeout: 0,
      title: "Connection error",
      type: "error",
    };
  }

  switch (state) {
    case "done": {
      return {
        description: "You can now have look at your receipt data",
        timeout: 10_000,
        title: "Done!",
        type: "success",
      };
    }
    case "failed": {
      return {
        description:
          stateError && isUserMessage(stateError)
            ? stateError
            : USER_ERROR.generic,
        timeout: 0,
        title: "Processing failed",
        type: "error",
      };
    }
    default: {
      // In flight, or waiting for the first stage: the card carries it.
      return null;
    }
  }
};

/**
 * Reports the outcome of one upload — a finished receipt, a failed run, or a
 * dropped socket — in the app's single toast region.
 *
 * Only an outcome is news: nothing is written while the run is merely
 * progressing. The stages are shown by the upload card (`resolveProgressLabel`
 * feeds its status), so the one polite live region never announces an
 * interstitial "Loading…". See the accessibility guide, §8.
 */
export const ReceiptToastNotifier = ({
  error,
  state,
  stateError,
}: {
  error: Error | null;
  state: ReceiptState | undefined;
  stateError: string | undefined;
}) => {
  const toastIdRef = useRef<string | null>(null);
  const isTerminalRef = useRef(false);

  useEffect(() => {
    const body = resolveToastBody({ error, state, stateError });

    isTerminalRef.current = state === "done" || state === "failed";

    if (!body) {
      // Mid-flight, or a socket error that has since recovered: clear whatever
      // this component put up, so a sticky "Connection error" cannot outlive
      // the failure it reported.
      if (toastIdRef.current) {
        toast.close(toastIdRef.current);
        toastIdRef.current = null;
      }
      return;
    }

    if (toastIdRef.current) {
      toast.update(toastIdRef.current, body);
    } else {
      toastIdRef.current = toast.add(body);
    }
  }, [state, stateError, error]);

  useEffect(
    () => () => {
      if (toastIdRef.current && !isTerminalRef.current) {
        toast.close(toastIdRef.current);
        toastIdRef.current = null;
      }
    },
    []
  );

  // The app-wide `<Toaster />` in `app/layout.tsx` renders whatever this
  // component puts in the shared manager, so there is no viewport — and no
  // second live region — of its own.
  return null;
};
