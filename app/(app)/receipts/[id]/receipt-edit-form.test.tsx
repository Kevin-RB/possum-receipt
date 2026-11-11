// @vitest-environment jsdom

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { updateReceipt } from "./actions";
import type { ReceiptWithItems } from "./receipt-edit-form";
import { ReceiptEditForm } from "./receipt-edit-form";

// The save action is a server action over Postgres; these tests never submit a
// valid form, so the module only has to exist.
vi.mock(import("./actions"), () => ({
  updateReceipt: vi.fn<typeof updateReceipt>(),
}));

const receipt: ReceiptWithItems = {
  categorizedAt: null,
  createdAt: new Date("2026-10-15T08:35:00Z"),
  gst: 1,
  hasIntegrityWarning: false,
  id: "11111111-1111-4111-8111-111111111111",
  merchantAbn: "00 000 000 000",
  merchantAddress: "1 Queen St",
  merchantName: "Corner Store",
  merchantStoreId: "1234",
  objectKey: null,
  paymentMethod: "card",
  processingStartedAt: null,
  receiptItems: [
    {
      categoryId: null,
      categorySource: "ai",
      id: "22222222-2222-4222-8222-222222222222",
      kind: "product",
      lineTotal: 10,
      name: "Coffee",
      quantity: 1,
      receiptId: "11111111-1111-4111-8111-111111111111",
      unitPrice: 10,
    },
  ],
  receiptNumber: "0001",
  status: "done",
  subtotal: 10,
  total: 11,
  transactionDateTime: "2026-10-15 18:35:00",
  transactionTimezone: "Australia/Brisbane",
  transcript: null,
  userId: "user-1",
};

const renderForm = (overrides: Partial<ReceiptWithItems> = {}) =>
  render(
    <ReceiptEditForm
      categoryGroups={[]}
      receipt={{ ...receipt, ...overrides }}
      today="2026-11-11"
      viewerZone="Australia/Brisbane"
    />
  );

/** The text a control is described by, joined from the ids it references. */
const describedText = (control: Element) =>
  (control.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.querySelector(`#${id}`)?.textContent ?? "")
    .join(" ");

describe(ReceiptEditForm, () => {
  it("names each single-value field by its visible label", () => {
    renderForm();

    for (const label of [
      "Address",
      "ABN",
      "Store ID",
      "Receipt Number",
      "Subtotal",
      "GST",
      "Total",
      "Added from",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
  });

  it("gives the item row's fields their own label targets", () => {
    renderForm();

    // The row is scoped by the button that belongs to it, so a label resolving
    // here cannot be the merchant's field of the same name.
    const row = screen
      .getByRole("button", { name: "Remove Coffee" })
      .closest<HTMLElement>('[data-slot="field-group"]');
    expect(row).not.toBeNull();

    for (const label of ["Name", "Quantity", "Unit Price", "Line Total"]) {
      expect(within(row as HTMLElement).getByLabelText(label)).toBeTruthy();
    }

    const names = screen.getAllByLabelText("Name");
    expect(names).toHaveLength(2);
    expect(new Set(names.map((input) => input.id)).size).toBe(names.length);
    expect(names.every((input) => input.id)).toBeTruthy();
  });

  it("names each trigger after the label the reader can see", () => {
    renderForm();

    // The visible label comes first (`^`), so a voice-control user saying it
    // still activates the control (WCAG 2.5.3), and the date trigger keeps the
    // day it shows as part of its name.
    expect(screen.getByLabelText(/^Date & Time/u)).toBeTruthy();
    expect(screen.getByLabelText("Added from")).toBeTruthy();
    expect(screen.getByLabelText("Category")).toBeTruthy();
    expect(screen.getByLabelText("Kind")).toBeTruthy();
  });

  it("filters the zones as you type and stores the chosen one", async () => {
    renderForm();

    const input = screen.getByLabelText("Added from") as HTMLInputElement;
    expect(input.value).toBe("Australia/Brisbane");
    expect(screen.getByText(/Added from Brisbane/u)).toBeTruthy();

    // The list opens from the field's own affordance, then the typing filters
    // it: jsdom cannot synthesize a keystroke that opens it on its own, because
    // Base UI opens on an `input` event that reports its `inputType`.
    fireEvent.click(screen.getByRole("button", { name: "Show timezones" }));

    // Opening shows the whole list — the selected label is not treated as a query.
    await expect(
      screen.findByRole("option", { name: "Not set" })
    ).resolves.toBeTruthy();

    fireEvent.change(input, { target: { value: "bris" } });
    await expect(
      screen.findByRole("option", { name: "Australia/Brisbane" })
    ).resolves.toBeTruthy();

    // "/" and "_" are word breaks: the IANA spelling must not demand the exact
    // punctuation a place name is typed without.
    fireEvent.change(input, { target: { value: "new york" } });
    const option = await screen.findByRole("option", {
      name: "America/New_York",
    });
    expect(
      screen.queryByRole("option", { name: "Australia/Brisbane" })
    ).toBeNull();

    fireEvent.click(option);

    // The input shows the choice, and the form state carries it: the caption
    // under the field is rendered from the form's own watched value.
    await waitFor(() => {
      expect(input.value).toBe("America/New_York");
      expect(screen.getByText(/Added from New York/u)).toBeTruthy();
    });
  });

  it("describes the date and its time with the zone caption", () => {
    renderForm();

    // Both halves of the datetime are described by the caption: it says where
    // the time above was read, and neither control reads it without it.
    expect(describedText(screen.getByLabelText(/^Date & Time/u))).toContain(
      "Added from Brisbane"
    );
    expect(describedText(screen.getByLabelText("Transaction time"))).toContain(
      "Added from Brisbane"
    );
  });

  it("does not describe the datetime with a caption that is not rendered", () => {
    renderForm({ transactionTimezone: null });

    expect(screen.queryByText(/^Added from Brisbane/u)).toBeNull();

    // No zone means no caption, so the id must not be referenced at all.
    expect(
      screen.getByLabelText(/^Date & Time/u).getAttribute("aria-describedby")
    ).toBeNull();
    expect(
      screen.getByLabelText("Transaction time").getAttribute("aria-describedby")
    ).toBeNull();
  });

  it("never points a control at a description that is not rendered", () => {
    const { container } = renderForm();

    const described = container.querySelectorAll("[aria-describedby]");
    expect(described.length).toBeGreaterThan(0);

    for (const control of described) {
      for (const id of control.getAttribute("aria-describedby")?.split(" ") ??
        []) {
        expect(document.querySelector(`#${id}`), `#${id}`).not.toBeNull();
      }
    }
  });

  it("marks a field invalid and describes it with its error", async () => {
    renderForm();

    // The merchant's is the first "Name" in the document; the item row's follows.
    const [merchantName] = screen.getAllByLabelText("Name");
    expect(merchantName).toBeDefined();

    fireEvent.change(merchantName as HTMLElement, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(merchantName?.getAttribute("aria-invalid")).toBe("true");
    });

    const errorId = merchantName?.getAttribute("aria-describedby");
    expect(errorId).toBeTruthy();
    expect(document.querySelector(`#${errorId}`)?.textContent).toBeTruthy();
  });
});
