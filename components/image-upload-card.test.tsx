// @vitest-environment jsdom

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { USER_ERROR } from "@/lib/errors";

import { ImageUploadCard } from "./image-upload-card";

// jsdom cannot decode an image; the upload is what is under test, not the
// compression, so the file passes through unchanged.
vi.mock(import("@/lib/images/compress-receipt-image"), () => ({
  compressReceiptImage: (file: File) => Promise.resolve(file),
}));

const BUSY_LABEL = "Engraving data in stone…";

const dropZone = () => screen.getByRole("button", { name: /drag and drop/iu });

const fileInput = () => screen.getByLabelText("Upload receipt image");

const cameraInput = () => screen.getByLabelText("Take a photo of a receipt");

const chooseImage = () => screen.getByRole("button", { name: "Choose image" });

const RECEIPT_ID = "receipt-1";

const UPLOAD_URL = "https://storage.test/receipt";

/**
 * jsdom has no object URLs, so there is nothing for `vi.spyOn` to wrap. The
 * card revokes its preview URL on unmount, so both have to exist for any test
 * that drives a real file through the form.
 */
const stubObjectUrls = () => {
  Object.assign(URL, {
    createObjectURL: () => "blob:preview",
    revokeObjectURL: () => {},
  });
};

const restoreObjectUrls = () => {
  Reflect.deleteProperty(URL, "createObjectURL");
  Reflect.deleteProperty(URL, "revokeObjectURL");
};

/**
 * The three requests a successful upload makes: a presigned URL, the PUT, and
 * the confirmation that follows it. The confirmation is the one a test gets to
 * decide the answer to.
 */
const stubUploadFetch = (confirm: () => Promise<Response>) => {
  const fetchMock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >((input) => {
    const url = String(input);
    if (url === "/api/upload") {
      return Promise.resolve(
        Response.json({ receiptId: RECEIPT_ID, uploadUrl: UPLOAD_URL })
      );
    }
    if (url === UPLOAD_URL) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }

    return confirm();
  });
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
};

describe(ImageUploadCard, () => {
  it("takes its accessible name from its visible copy", () => {
    render(<ImageUploadCard />);

    // WCAG 2.5.3: no `aria-label`, so the name is the copy a voice-control user
    // can read. jsdom applies no Tailwind, so both breakpoint sentences are
    // present here; in a browser each is `display: none` at the other
    // breakpoint, and neither is `sr-only`, so exactly one survives.
    const button = screen.getByRole("button", { name: /drag and drop/iu });

    expect(button.hasAttribute("aria-label")).toBeFalsy();
    expect(button.textContent).toMatch(/click to browse or drag and drop/iu);
    expect(button.textContent).toMatch(/take a photo or choose one below/iu);
    expect(button.querySelector(".sr-only")).toBeNull();
  });

  it("keeps focus on the upload button while it is busy", () => {
    const { rerender } = render(<ImageUploadCard />);
    const button = dropZone();
    button.focus();

    // The parent learns the upload finished and starts processing, which makes
    // the card busy. `disabled` would drop focus to <body> here.
    rerender(<ImageUploadCard processingLabel={BUSY_LABEL} />);

    expect(document.activeElement).toBe(button);
    expect(button.hasAttribute("disabled")).toBeFalsy();
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("ignores an activation while busy instead of removing the button", () => {
    const { rerender } = render(<ImageUploadCard />);
    const picker = vi.spyOn(fileInput(), "click");
    const camera = vi.spyOn(cameraInput(), "click");

    // The drop zone opens the camera on a phone, and the button below it opens
    // the picker. Both work while the card is idle…
    fireEvent.click(dropZone());
    fireEvent.click(chooseImage());
    expect(camera).toHaveBeenCalledOnce();
    expect(picker).toHaveBeenCalledOnce();

    // …and both are refused while it is busy. The guard in the handler is what
    // refuses them; the controls stay focusable and in the accessibility tree.
    rerender(<ImageUploadCard processingLabel={BUSY_LABEL} />);
    fireEvent.click(dropZone());
    fireEvent.click(chooseImage());
    expect(camera).toHaveBeenCalledOnce();
    expect(picker).toHaveBeenCalledOnce();
  });

  it("describes the busy button with the stage it is on", () => {
    render(<ImageUploadCard processingLabel={BUSY_LABEL} />);

    const button = dropZone();
    const status = screen.getByText(BUSY_LABEL);

    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(button.getAttribute("aria-describedby")).toBe(status.id);
  });

  it("shows the stage as a shimmering line, without a spinner", () => {
    render(<ImageUploadCard processingLabel={BUSY_LABEL} />);

    const status = screen.getByText(BUSY_LABEL);

    // The shimmer is what makes the text read as work in flight — the same
    // class the chat's question card and running trace lines use.
    expect(status.classList.contains("shimmer")).toBeTruthy();
    // The moving line replaced the spinner: three animations at once is too much.
    expect(status.querySelector("svg")).toBeNull();
    expect(document.querySelector("svg.animate-spin")).toBeNull();
  });

  it("renders an indeterminate bar named by the stage", () => {
    render(<ImageUploadCard processingLabel={BUSY_LABEL} />);

    const bar = screen.getByRole("progressbar", { name: BUSY_LABEL });

    // No `value`: indeterminate. Named by the stage text; not focusable, and
    // with no fallback text inside it.
    expect(bar.hasAttribute("value")).toBeFalsy();
    expect(bar.getAttribute("aria-labelledby")).toBe(
      screen.getByText(BUSY_LABEL).id
    );
    expect(bar.hasAttribute("tabindex")).toBeFalsy();
    expect(bar.textContent).toBe("");
  });

  it("keeps the stage and the bar mounted while the stage changes", () => {
    const { rerender } = render(
      <ImageUploadCard processingLabel="Starting the upload…" />
    );
    const status = screen.getByText("Starting the upload…");
    const bar = screen.getByRole("progressbar");

    rerender(<ImageUploadCard processingLabel="Uploading your receipt…" />);

    // The same nodes with new text: neither the shimmer nor the segment is
    // restarted when the stage moves on.
    expect(screen.getByText("Uploading your receipt…")).toBe(status);
    expect(screen.getByRole("progressbar")).toBe(bar);
    expect(bar.getAttribute("aria-labelledby")).toBe(status.id);
  });

  it("shows no progress bar when idle", () => {
    render(<ImageUploadCard />);

    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("focuses the drop zone on mount when the parent asks for it", () => {
    // What `UploadFlow` does when it replaces a card that held focus.
    render(<ImageUploadCard autoFocusOnMount />);

    expect(document.activeElement).toBe(dropZone());
  });

  it("does not take focus on mount otherwise", () => {
    render(<ImageUploadCard />);

    expect(document.activeElement).toBe(document.body);
  });

  it("clears the stage when an upload fails", async () => {
    // The failure path has no remount to hide a stale stage behind, unlike a
    // finished upload, so the card itself has to stop reporting one.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          Response.json({ error: "nope" }, { status: 500 }) as Response
        )
      )
    );
    // jsdom has no object URLs; the preview is not what is under test.
    stubObjectUrls();
    const onUploadError = vi.fn<() => void>();
    const { unmount } = render(
      <ImageUploadCard onUploadError={onUploadError} />
    );

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "r.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(onUploadError).toHaveBeenCalledOnce());
    // The drop zone now holds the preview, so its name is the image's; the
    // picker button carries the same busy wiring and keeps its name.
    await waitFor(() =>
      expect(chooseImage().getAttribute("aria-disabled")).toBe("false")
    );
    expect(screen.getByText(USER_ERROR.uploadFailed)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("Starting the upload…")).toBeNull();
    expect(chooseImage().hasAttribute("aria-describedby")).toBeFalsy();

    // Unmount before removing the stubs: the card revokes its preview URL on
    // unmount.
    unmount();
    vi.unstubAllGlobals();
    restoreObjectUrls();
  });

  it("confirms the upload with the receipt id once the PUT succeeds", async () => {
    const fetchMock = stubUploadFetch(() =>
      Promise.resolve(Response.json({ received: true }))
    );
    stubObjectUrls();
    const onUploadComplete = vi.fn<(receiptId: string) => void>();
    const onUploadStateChange = vi.fn<(stage: string) => void>();
    const { unmount } = render(
      <ImageUploadCard
        onUploadComplete={onUploadComplete}
        onUploadStateChange={onUploadStateChange}
      />
    );

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "r.png", { type: "image/png" })] },
    });

    await waitFor(() =>
      expect(onUploadComplete).toHaveBeenCalledWith(RECEIPT_ID)
    );

    // Three requests in order, and the last names the receipt — never the
    // object key, which is server-owned (ADR-0021).
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toStrictEqual([
      "/api/upload",
      UPLOAD_URL,
      "/api/storage-events",
    ]);
    const confirmInit = fetchMock.mock.calls.at(-1)?.[1];
    expect(confirmInit?.method).toBe("POST");
    expect(JSON.parse(String(confirmInit?.body))).toStrictEqual({
      receiptId: RECEIPT_ID,
    });

    // The confirmation is a stage of its own, so the card says what it is doing
    // rather than freezing on the upload it already finished.
    expect(onUploadStateChange).toHaveBeenLastCalledWith("confirming-upload");

    unmount();
    vi.unstubAllGlobals();
    restoreObjectUrls();
  });

  it("does not report success when the server refuses to confirm the upload", async () => {
    // The PUT succeeded but the object was not there when the server looked, so
    // it answers 409 and leaves the row `uploading` for reconciliation. A card
    // that trusted its own PUT would show a receipt that does not exist.
    const confirm = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(
        Response.json({ error: USER_ERROR.uploadFailed }, { status: 409 })
      );
    stubUploadFetch(confirm);
    stubObjectUrls();
    const onUploadComplete = vi.fn<(receiptId: string) => void>();
    const onUploadError = vi.fn<() => void>();
    const { unmount } = render(
      <ImageUploadCard
        onUploadComplete={onUploadComplete}
        onUploadError={onUploadError}
      />
    );

    fireEvent.change(fileInput(), {
      target: { files: [new File(["x"], "r.png", { type: "image/png" })] },
    });

    await waitFor(() => expect(onUploadError).toHaveBeenCalledOnce());

    // A refusal will not change on a second ask, so it is not retried.
    expect(confirm).toHaveBeenCalledOnce();
    expect(onUploadComplete).not.toHaveBeenCalled();
    // Catalogue wording from the failure body reaches the field; the card is
    // idle again and the reader can retry.
    expect(screen.getByText(USER_ERROR.uploadFailed)).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(chooseImage().getAttribute("aria-disabled")).toBe("false");

    unmount();
    vi.unstubAllGlobals();
    restoreObjectUrls();
  });

  it("retries a confirmation that answers 5xx and still completes", async () => {
    // Each confirmation is idempotent, so a transient server failure is worth
    // another ask — the successful third attempt is what calls
    // `onUploadComplete`, and the reader never sees an error.
    const confirm = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json({ error: USER_ERROR.generic }, { status: 500 })
      )
      .mockResolvedValueOnce(
        Response.json({ error: USER_ERROR.generic }, { status: 500 })
      )
      .mockResolvedValueOnce(Response.json({ received: true }));
    stubUploadFetch(confirm);
    stubObjectUrls();
    const onUploadComplete = vi.fn<(receiptId: string) => void>();
    const onUploadError = vi.fn<() => void>();
    const { unmount } = render(
      <ImageUploadCard
        onUploadComplete={onUploadComplete}
        onUploadError={onUploadError}
      />
    );

    vi.useFakeTimers();
    try {
      fireEvent.change(fileInput(), {
        target: { files: [new File(["x"], "r.png", { type: "image/png" })] },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(onUploadComplete).toHaveBeenCalledWith(RECEIPT_ID);
    expect(onUploadError).not.toHaveBeenCalled();
    expect(screen.queryByText(USER_ERROR.uploadUnconfirmed)).toBeNull();

    unmount();
    vi.unstubAllGlobals();
    restoreObjectUrls();
  });

  it("says the photo may still arrive when the confirmation keeps failing", async () => {
    // The object is in the bucket and `/receipts` will settle the row, so
    // telling the reader the upload failed sends them back to upload the same
    // photo again — two receipts for one image (ADR-0021).
    const confirm = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValue(
        Response.json({ error: USER_ERROR.generic }, { status: 503 })
      );
    stubUploadFetch(confirm);
    stubObjectUrls();
    const onUploadComplete = vi.fn<(receiptId: string) => void>();
    const onUploadError = vi.fn<() => void>();
    const { unmount } = render(
      <ImageUploadCard
        onUploadComplete={onUploadComplete}
        onUploadError={onUploadError}
      />
    );

    vi.useFakeTimers();
    try {
      fireEvent.change(fileInput(), {
        target: { files: [new File(["x"], "r.png", { type: "image/png" })] },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    } finally {
      vi.useRealTimers();
    }

    expect(confirm).toHaveBeenCalledTimes(3);
    expect(onUploadComplete).not.toHaveBeenCalled();
    expect(onUploadError).toHaveBeenCalledOnce();
    expect(screen.getByText(USER_ERROR.uploadUnconfirmed)).toBeTruthy();
    expect(screen.queryByText(USER_ERROR.uploadFailed)).toBeNull();

    unmount();
    vi.unstubAllGlobals();
    restoreObjectUrls();
  });

  it("leaves the button described by nothing when idle", () => {
    render(<ImageUploadCard />);

    expect(dropZone().getAttribute("aria-disabled")).toBe("false");
    expect(dropZone().hasAttribute("aria-describedby")).toBeFalsy();
  });
});
