"use client";

import type { FocusEvent } from "react";
import { useState } from "react";

import {
  ReceiptToastNotifier,
  resolveProgressLabel,
} from "@/components/receipt-toast-notifier";
import {
  useReceiptState,
  useReceiptsRealtime,
} from "@/components/receipts/receipts-realtime-context";
import { Card, CardContent, CardFooter } from "@/components/ui/card";

import { ImageUploadCard } from "./image-upload-card";

type UploadMachine =
  | { status: "done"; receiptId: string }
  | { status: "idle" }
  | { status: "requesting-url" }
  | { status: "uploading-to-storage" };

/**
 * Whether focus is inside the card right now, tracked from the wrapper so it
 * survives the card being replaced below.
 *
 * A browser does not fire `focusout` when the focused element is removed from
 * the document, so at the moment of the remount this still says `true` — which
 * is exactly the case where focus has to be put back. Focus that moved
 * somewhere else first is reported like any other blur, so nothing is stolen.
 */
const useFocusWithin = () => {
  const [isFocusWithin, setIsFocusWithin] = useState(false);

  return {
    handleBlur: (event: FocusEvent<HTMLElement>) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
        setIsFocusWithin(false);
      }
    },
    handleFocus: () => {
      setIsFocusWithin(true);
    },
    isFocusWithin,
  };
};

export const UploadFlow = () => {
  const [upload, setUpload] = useState<UploadMachine>({ status: "idle" });
  const [completedReceiptId, setCompletedReceiptId] = useState<string | null>(
    null
  );
  const focusWithin = useFocusWithin();
  const { error } = useReceiptsRealtime();
  const receiptId = upload.status === "done" ? upload.receiptId : null;
  const liveState = useReceiptState(receiptId ?? "");
  const state = liveState?.state;
  const isTerminalState = state === "done" || state === "failed";
  const isProcessing = upload.status === "done" && !isTerminalState;

  // Remount the upload card once a completed upload reaches a terminal state so
  // its preview and file selection are cleared for the next receipt. State is
  // adjusted during render (guarded against a loop), the documented pattern for
  // deriving state from changing inputs; an effect is not used because
  // react-compiler's EffectSetState rule rejects setState in effect bodies.
  if (isTerminalState && receiptId && completedReceiptId !== receiptId) {
    setCompletedReceiptId(receiptId);
  }
  const uploadCardKey = completedReceiptId ?? "active";

  return (
    <>
      <Card
        className="w-full max-w-md"
        onBlur={focusWithin.handleBlur}
        onFocus={focusWithin.handleFocus}
      >
        <CardContent>
          <ImageUploadCard
            key={uploadCardKey}
            autoFocusOnMount={focusWithin.isFocusWithin}
            processingLabel={
              isProcessing ? resolveProgressLabel(state) : undefined
            }
            onUploadComplete={(id) =>
              setUpload({ receiptId: id, status: "done" })
            }
            onUploadError={() => setUpload({ status: "idle" })}
            onUploadStateChange={(stage) => setUpload({ status: stage })}
          />
        </CardContent>
        <CardFooter className="justify-center">
          Upload a receipt image to get AI-powered insights.
        </CardFooter>
      </Card>
      {upload.status === "done" && (
        <ReceiptToastNotifier
          error={error}
          state={state}
          stateError={liveState?.error}
        />
      )}
    </>
  );
};
