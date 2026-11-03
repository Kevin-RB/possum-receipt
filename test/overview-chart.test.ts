import { describe, expect, it } from "vitest";

import { DIM_OPACITY, datumOpacity } from "@/lib/overview-chart";

describe(datumOpacity, () => {
  it("draws every datum at full strength while nothing is open", () => {
    expect(datumOpacity({ date: "2026-11-03", kind: "day" }, null)).toBe(1);
  });

  it("keeps the open datum at full strength and steps the rest back", () => {
    const selected = { date: "2026-11-03", kind: "day" } as const;

    expect(datumOpacity(selected, selected)).toBe(1);
    expect(datumOpacity({ date: "2026-11-04", kind: "day" }, selected)).toBe(
      DIM_OPACITY
    );
  });

  it("compares buckets by identity, not by object reference", () => {
    expect(
      datumOpacity(
        { kind: "category", slug: "pharmacy" },
        { kind: "category", slug: "pharmacy" }
      )
    ).toBe(1);
    expect(
      datumOpacity(
        { kind: "merchant", merchant: "Coles" },
        { kind: "merchant", merchant: "Kmart" }
      )
    ).toBe(DIM_OPACITY);
  });

  it("distinguishes the merged Other slice from a merchant of that name", () => {
    expect(
      datumOpacity(
        { kind: "other-merchants" },
        { kind: "merchant", merchant: "Other" }
      )
    ).toBe(DIM_OPACITY);
  });
});
