// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ImageUploadCard } from "./image-upload-card";

const BUSY_LABEL = "Engraving data in stone…";

const dropZone = () => screen.getByRole("button", { name: /drag and drop/iu });

const fileInput = () => screen.getByLabelText("Upload receipt image");

const cameraInput = () => screen.getByLabelText("Take a photo of a receipt");

const chooseImage = () => screen.getByRole("button", { name: "Choose image" });

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

  it("leaves the button described by nothing when idle", () => {
    render(<ImageUploadCard />);

    expect(dropZone().getAttribute("aria-disabled")).toBe("false");
    expect(dropZone().hasAttribute("aria-describedby")).toBeFalsy();
  });
});
