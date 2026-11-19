import { describe, expect, it } from "vitest";

import {
  refreshForTransition,
  stateTier,
} from "@/components/receipts/refresh-policy";

describe(stateTier, () => {
  it("treats a live stage as active and a finished one as terminal", () => {
    expect(stateTier("extracting")).toBe("active");
    expect(stateTier("storing")).toBe("active");
    expect(stateTier("done")).toBe("terminal");
    expect(stateTier("failed")).toBe("terminal");
  });
});

describe(refreshForTransition, () => {
  it("refreshes when a run reaches a terminal state", () => {
    expect(refreshForTransition("active", "done", true)).toBe("schedule");
    expect(refreshForTransition("active", "failed", true)).toBe("schedule");
  });

  it("refreshes once per completion, not once per message", () => {
    expect(refreshForTransition("terminal", "done", true)).toBe("none");
    expect(refreshForTransition("terminal", "failed", true)).toBe("none");
  });

  it("refreshes again when a finished receipt is re-processed", () => {
    // done -> (re-process starts) active -> done
    expect(refreshForTransition("terminal", "extracting", true)).toBe("none");
    expect(refreshForTransition("active", "done", true)).toBe("schedule");
  });

  it("refreshes when a receipt not on the page starts, so its row appears", () => {
    expect(refreshForTransition(undefined, "extracting", false)).toBe(
      "schedule"
    );
  });

  it("does not refresh progress for a row already on the page", () => {
    expect(refreshForTransition(undefined, "extracting", true)).toBe("none");
    expect(refreshForTransition("active", "storing", true)).toBe("none");
  });
});
