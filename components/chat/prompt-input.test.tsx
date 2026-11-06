// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { keyOf, remoteCatalogue } from "@/lib/chat/catalogue";

import { PromptInput } from "./prompt-input";

const renderInput = () =>
  render(
    <PromptInput
      entries={remoteCatalogue}
      isBusy={false}
      model={keyOf(remoteCatalogue[0])}
      onChangeModel={() => 0}
      onStop={() => 0}
      onSubmit={() => 0}
      placeholder="Ask about your receipts…"
    />
  );

describe(PromptInput, () => {
  it("focuses the textarea when the footer is tapped", () => {
    const { container } = renderInput();
    const textarea = screen.getByPlaceholderText("Ask about your receipts…");

    // The footer strip beside the send button is the part of the composer a
    // reader taps by mistake. It has to behave like the rest of the box.
    const footer = container.querySelector('[data-slot="input-group-addon"]');
    if (!footer) {
      throw new Error("the composer has no footer");
    }
    fireEvent.click(footer);

    expect(document.activeElement).toBe(textarea);
  });

  it("leaves the send button alone, so it submits instead of focusing", () => {
    renderInput();
    const textarea = screen.getByPlaceholderText("Ask about your receipts…");

    fireEvent.click(screen.getByLabelText("Send"));

    expect(document.activeElement).not.toBe(textarea);
  });
});
