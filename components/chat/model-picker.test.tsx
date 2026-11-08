// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatSelection } from "@/lib/chat/catalogue";

import { ModelPicker } from "./model-picker";

const remote: ChatSelection = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  provider: "openrouter",
};

const local: ChatSelection = {
  model: "google/gemma-4-e4b",
  provider: "local",
};

const renderPicker = (selections: ChatSelection[], value: ChatSelection) => {
  const onChange = vi.fn<(next: ChatSelection) => void>();

  render(
    <ModelPicker onChange={onChange} selections={selections} value={value} />
  );

  return onChange;
};

/** The label starts with `Choose a model` and names the current selection. */
const trigger = (label: string) =>
  screen.getByLabelText(`Choose a model: ${label}`);

/**
 * The trigger opens on the press, in a frame Base UI schedules, so the menu is
 * awaited rather than asserted on synchronously.
 */
const openMenu = async () => {
  fireEvent.mouseDown(screen.getByLabelText(/^Choose a model/u));

  await waitFor(() => {
    expect(screen.getByRole("menu")).toBeTruthy();
  });
};

describe(ModelPicker, () => {
  it("names the selected model without its author segment", () => {
    renderPicker([remote, local], remote);

    expect(trigger("deepseek-v4.1-flash-1017").textContent).toBe(
      "deepseek-v4.1-flash-1017"
    );
  });

  it("groups under a heading per provider when two resolve", async () => {
    renderPicker([remote, local], remote);
    await openMenu();

    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    expect(screen.getByText("OpenRouter")).toBeTruthy();
    expect(screen.getByText("Local")).toBeTruthy();
  });

  it("stays a flat list when one provider resolves, naming the local model", async () => {
    renderPicker([local], local);
    await openMenu();

    const [item] = screen.getAllByRole("menuitemradio");

    expect(item?.textContent).toBe("local (gemma-4-e4b)");
    expect(screen.queryByText("Local")).toBeNull();
  });

  it("reports the chosen entry as the selection the route takes", async () => {
    const onChange = renderPicker([remote, local], remote);
    await openMenu();

    fireEvent.click(screen.getByText("local (gemma-4-e4b)"));

    expect(onChange).toHaveBeenCalledWith(local);
  });
});
