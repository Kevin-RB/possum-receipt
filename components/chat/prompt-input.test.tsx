// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ChatSelection } from "@/lib/chat/catalogue";

import { PromptInput } from "./prompt-input";

const remote: ChatSelection = {
  model: "deepseek/deepseek-v4.1-flash",
  provider: "openrouter",
};

const local: ChatSelection = {
  model: "google/gemma-4-e4b",
  provider: "local",
};

const renderInput = () =>
  render(
    <PromptInput
      isBusy={false}
      model={remote}
      onChangeModel={() => 0}
      onStop={() => 0}
      onSubmit={() => 0}
      placeholder="Ask about your receipts…"
      selections={[remote, local]}
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

  it("leaves the model picker alone, so it opens instead of focusing", () => {
    renderInput();
    const textarea = screen.getByPlaceholderText("Ask about your receipts…");

    fireEvent.click(screen.getByLabelText(/^Choose a model/u));

    expect(document.activeElement).not.toBe(textarea);
  });

  it("puts the picker beside the send button, in the footer", () => {
    const { container } = renderInput();
    const footer = container.querySelector('[data-slot="input-group-addon"]');

    expect(
      footer?.querySelector('[aria-label^="Choose a model"]')
    ).toBeTruthy();
    expect(footer?.textContent).toContain("deepseek-v4.1-flash");
  });
});
