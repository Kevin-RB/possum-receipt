// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { UseRealtimeConnectionStatus } from "inngest/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ReceiptsRealtimeContext } from "@/components/receipts/receipts-realtime-context";
import type { ReceiptsRealtimeValue } from "@/components/receipts/receipts-realtime-context";
import { toast } from "@/components/ui/toast";
import { UploadFlow } from "@/components/upload-flow";
import type { ReceiptStateData } from "@/lib/inngest/channels";

// The card compresses with a canvas and uploads to RustFS. Neither exists here:
// what this file tests is where focus goes when a finished card is replaced.
vi.mock(import("@/lib/images/compress-receipt-image"), () => ({
  compressReceiptImage: (file: File) => Promise.resolve(file),
}));

const RECEIPT_ID = "receipt-1";

/** Mutated in place between renders; the flow reads it through context. */
const byReceipt = new Map<string, ReceiptStateData>();

const realtime: ReceiptsRealtimeValue = {
  byReceipt,
  connectionStatus: "connected" as UseRealtimeConnectionStatus,
  error: null,
};

// The drop zone is named by its own copy while idle and by the preview's alt
// text once a receipt is picked, so the query covers both states.
const dropZone = () =>
  screen.getByRole("button", { name: /drag and drop|receipt preview/iu });

const elsewhere = () => screen.getByRole("button", { name: "Elsewhere" });

const flow = () => (
  <>
    <button type="button">Elsewhere</button>
    <ReceiptsRealtimeContext.Provider value={realtime}>
      <UploadFlow />
    </ReceiptsRealtimeContext.Provider>
  </>
);

/** The two requests a real upload makes: a presigned URL, then the PUT. */
const stubUploadFetch = () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      String(input) === "/api/upload"
        ? Promise.resolve({
            json: () =>
              Promise.resolve({
                receiptId: RECEIPT_ID,
                uploadUrl: "https://storage.test/receipt",
              }),
            ok: true,
          })
        : Promise.resolve({ ok: true })
    )
  );
};

/** Drive the real upload path: pick a file, and let it land as `done`. */
const upload = async () => {
  act(() => {
    fireEvent.change(screen.getByLabelText("Upload receipt image"), {
      target: {
        files: [new File(["receipt"], "receipt.png", { type: "image/png" })],
      },
    });
  });
  // The card reports its stage through `onUploadStateChange`; the flow is only
  // waiting on the run once the upload itself has finished.
  await expect(
    screen.findByText("Waiting for the server…")
  ).resolves.toBeTruthy();
};

describe(UploadFlow, () => {
  beforeAll(() => {
    URL.createObjectURL = () => "blob:preview";
    URL.revokeObjectURL = () => {};
  });

  afterEach(() => {
    byReceipt.clear();
    act(() => {
      toast.close();
    });
    vi.unstubAllGlobals();
  });

  it("puts focus back on the drop zone when the finished card is replaced", async () => {
    stubUploadFetch();

    const { rerender } = render(flow());
    act(() => {
      dropZone().focus();
    });
    await upload();

    const finished = dropZone();

    // The run finishes: the flow remounts the card to clear the preview. The
    // old drop zone leaves the document, so focus would fall to <body>.
    byReceipt.set(RECEIPT_ID, { receiptId: RECEIPT_ID, state: "done" });
    rerender(flow());

    expect(dropZone()).not.toBe(finished);
    expect(document.activeElement).toBe(dropZone());
  });

  it("leaves focus alone when the reader had moved on", async () => {
    stubUploadFetch();

    const { rerender } = render(flow());
    act(() => {
      dropZone().focus();
    });
    await upload();

    // Nothing of the card is where the reader is any more; the remount must
    // not pull focus back out of whatever they moved on to.
    act(() => {
      elsewhere().focus();
    });
    byReceipt.set(RECEIPT_ID, { receiptId: RECEIPT_ID, state: "done" });
    rerender(flow());

    expect(document.activeElement).toBe(elsewhere());
  });
});
