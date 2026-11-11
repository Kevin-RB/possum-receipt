// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatSelection } from "@/lib/chat/catalogue";

import { PromptInput } from "./prompt-input";

const remote: ChatSelection = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  provider: "openrouter",
};

const local: ChatSelection = {
  model: "google/gemma-4-e4b",
  provider: "local",
};

const renderInput = (onSubmit: (text: string) => void = () => 0) =>
  render(
    <PromptInput
      isBusy={false}
      model={remote}
      onChangeModel={() => 0}
      onStop={() => 0}
      onSubmit={onSubmit}
      placeholder="Ask about your receipts…"
      selections={[remote, local]}
    />
  );

describe(PromptInput, () => {
  it("names the composer, since a placeholder is not a label", () => {
    renderInput();

    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });

  it("sends on a plain Enter", () => {
    const onSubmit = vi.fn<(text: string) => void>();
    renderInput(onSubmit);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(textarea, { target: { value: "how much this month?" } });

    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith("how much this month?");
  });

  it("leaves the confirming Enter of an IME composition alone", () => {
    const onSubmit = vi.fn<(text: string) => void>();
    renderInput(onSubmit);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(textarea, { target: { value: "先月の食料品" } });

    // Safari can deliver `compositionend` before the keydown that confirmed
    // the candidate, so `isComposing` is already false by the time the handler
    // runs. The keystroke still reports `keyCode` 229 (VK_PROCESSKEY), which is
    // what keeps a half-typed character out of the message.
    fireEvent.keyDown(textarea, {
      isComposing: false,
      key: "Enter",
      keyCode: 229,
    });

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("leaves the Enter that arrives mid-composition alone", () => {
    const onSubmit = vi.fn<(text: string) => void>();
    renderInput(onSubmit);
    const textarea = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(textarea, { target: { value: "先月の食" } });

    fireEvent.keyDown(textarea, { isComposing: true, key: "Enter" });

    expect(onSubmit).not.toHaveBeenCalled();
  });

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
    expect(footer?.textContent).toContain("deepseek-v4.1-flash-1017");
  });
});
