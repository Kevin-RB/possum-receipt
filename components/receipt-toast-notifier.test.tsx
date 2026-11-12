// @vitest-environment jsdom

import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ReceiptToastNotifier,
  resolveProgressLabel,
  resolveToastBody,
} from "@/components/receipt-toast-notifier";
import { Toaster, toast } from "@/components/ui/toast";
import { USER_ERROR } from "@/lib/errors";
import type { ReceiptState } from "@/lib/inngest/channels";

const connectionError = () => new Error("socket closed");

const body = (input: {
  error?: Error | null;
  state?: ReceiptState;
  stateError?: string;
}) =>
  resolveToastBody({
    error: input.error ?? null,
    state: input.state,
    stateError: input.stateError,
  });

interface NotifierProps {
  error?: Error | null;
  state?: ReceiptState;
  stateError?: string;
}

/**
 * The app's own `<Toaster />`, exactly as `app/layout.tsx` mounts it, plus the
 * notifier: proof that the toast lands in the one shared live region rather
 * than one this component brings along.
 */
const renderNotifier = (props: NotifierProps) =>
  render(
    <>
      <Toaster />
      <ReceiptToastNotifier
        error={props.error ?? null}
        state={props.state}
        stateError={props.stateError}
      />
    </>
  );

describe(resolveToastBody, () => {
  it("does not replace a done toast with a socket error", () => {
    // A drop inside the success toast's 10s window must not hide the outcome.
    expect(body({ error: connectionError(), state: "done" })).toStrictEqual({
      description: "You can now have look at your receipt data",
      timeout: 10_000,
      title: "Done!",
      type: "success",
    });
  });

  it("keeps catalogue wording for a failed run", () => {
    expect(
      body({
        error: connectionError(),
        state: "failed",
        stateError: USER_ERROR.uploadFailed,
      })
    ).toStrictEqual({
      description: USER_ERROR.uploadFailed,
      timeout: 0,
      title: "Processing failed",
      type: "error",
    });
  });

  it("replaces a failure message the app does not own with the generic text", () => {
    // `stateError` is stored by the Inngest function: it can be a stack line,
    // a provider message or a status code, none of which may reach the reader.
    const result = body({ state: "failed", stateError: "OOM at worker.ts:12" });

    expect(result).toStrictEqual({
      description: USER_ERROR.generic,
      timeout: 0,
      title: "Processing failed",
      type: "error",
    });
  });

  it("falls back to the generic text when a failure carries no message", () => {
    expect(body({ state: "failed" })?.description).toBe(USER_ERROR.generic);
  });

  it("replaces a transport error message with the generic text", () => {
    const result = body({ error: connectionError() });

    expect(result).toStrictEqual({
      description: USER_ERROR.generic,
      timeout: 0,
      title: "Connection error",
      type: "error",
    });
  });

  it("reports a socket error while a run is mid-flight", () => {
    // A dropped socket is news even though the stages are not.
    expect(body({ error: connectionError(), state: "parsing" })?.title).toBe(
      "Connection error"
    );
  });

  it("announces nothing while the run is only progressing", () => {
    // Interstitial loading states stay out of the live region (guide §8): the
    // upload card shows them, and only an outcome is a toast.
    for (const state of ["storing", "extracting", "parsing"] as const) {
      expect(body({ state })).toBeNull();
    }
    expect(body({})).toBeNull();
  });
});

describe(resolveProgressLabel, () => {
  it("names the stage the upload card shows", () => {
    expect(resolveProgressLabel("storing")).toBe("Engraving data in stone…");
    expect(resolveProgressLabel("extracting")).toBe(
      "Gnomes are extracting data…"
    );
    expect(resolveProgressLabel("parsing")).toBe(
      "A magic cat is taking a look at your receipt…"
    );
  });

  it("waits for the first stage after the upload", () => {
    expect(resolveProgressLabel()).toBe("Waiting for the server…");
  });
});

describe(ReceiptToastNotifier, () => {
  afterEach(() => {
    // The manager is a module singleton, so a toast left behind would leak into
    // the next test's viewport.
    act(() => {
      toast.close();
    });
  });

  it("announces a failure in the app's single toast region", async () => {
    renderNotifier({ state: "failed", stateError: "OOM at worker.ts:12" });

    const region = screen.getByRole("region", { name: "Notifications" });
    await expect(
      within(region).findByText(USER_ERROR.generic)
    ).resolves.toBeTruthy();
    // One region, not two: the notifier used to mount a provider of its own
    // beside the app-wide Toaster, which meant two polite live regions.
    expect(
      screen.getAllByRole("region", { name: "Notifications" })
    ).toHaveLength(1);
  });

  it("says nothing while the run is only progressing", async () => {
    renderNotifier({ state: "extracting" });

    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).queryByText("Extraction")).toBeNull();
    expect(
      within(region).queryByText("Gnomes are extracting data…")
    ).toBeNull();

    // Flush the viewport's own transition work inside `act`, so the render it
    // triggers belongs to this test.
    await act(async () => {
      await Promise.resolve();
    });
  });
});
