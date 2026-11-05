import { describe, expect, it } from "vitest";

import { receiptZone, withZoneLabel } from "./zone-caption";

/**
 * The caption is the only place a receipt's zone reaches a reader. It answers
 * two questions and never a third: which city printed this clock, and what the
 * same moment reads on the reader's own clock. It never says which day the
 * receipt belongs to — that is the printed date (ADR-0015).
 */
describe(receiptZone, () => {
  it("names the city a receipt was added from", () => {
    expect(
      receiptZone({
        viewerZone: "America/Bogota",
        wallClock: "2026-10-17 09:35:00",
        zone: "Australia/Brisbane",
      })
    ).toMatchObject({
      differs: true,
      label: "Brisbane",
    });
  });

  it("reads the same moment on the reader's clock, naming the day it fell on", () => {
    // 9:35 am on Saturday 17 October in Brisbane is 6:35 pm on Friday the 16th
    // in Bogotá: a reader there would otherwise be told the wrong day as well
    // as the wrong hour.
    expect(
      receiptZone({
        viewerZone: "America/Bogota",
        wallClock: "2026-10-17 09:35:00",
        zone: "Australia/Brisbane",
      })?.viewerTime
    ).toBe("6:35 pm Fri 16 Oct your time");
  });

  it("omits the day when the reader is on the receipt's own day", () => {
    // Different zones, same offset — Brisbane and Port Moresby are both UTC+10
    // with no daylight saving, so the clock reads the same and only the label
    // differs.
    expect(
      receiptZone({
        viewerZone: "Pacific/Port_Moresby",
        wallClock: "2026-10-17 09:35:00",
        zone: "Australia/Brisbane",
      })
    ).toMatchObject({
      differs: true,
      viewerTime: "9:35 am your time",
    });
  });

  it("says nothing extra when the reader is in the printing zone", () => {
    expect(
      receiptZone({
        viewerZone: "Australia/Brisbane",
        wallClock: "2026-10-17 09:35:00",
        zone: "Australia/Brisbane",
      })
    ).toStrictEqual({
      differs: false,
      label: "Brisbane",
      zone: "Australia/Brisbane",
    });
  });

  it("has no caption for a receipt whose zone was never recorded", () => {
    // Every receipt stored before #200, and every one the browser could not
    // name. They render exactly as they always did.
    expect(
      receiptZone({
        viewerZone: "Australia/Brisbane",
        wallClock: "2026-10-17 09:35:00",
        zone: null,
      })
    ).toBeUndefined();
  });

  it("has no caption for a wall clock it cannot read", () => {
    // The manual edit form renders this from a field the user is mid-way
    // through: a half-typed value must not take the page down.
    expect(
      receiptZone({
        viewerZone: "Australia/Brisbane",
        wallClock: "",
        zone: "Australia/Brisbane",
      })
    ).toBeUndefined();
  });

  it("ignores a zone name that is not a zone", () => {
    // A stored column filled from a browser, so it can hold anything.
    expect(
      receiptZone({
        viewerZone: "Australia/Brisbane",
        wallClock: "2026-10-17 09:35:00",
        zone: "Australia/Nowhere",
      })
    ).toBeUndefined();
  });

  it("still reads a printed time that a spring-forward gap skipped", () => {
    // 2:30 am never happened in New York on 8 March 2026. The printed time is
    // data and stays as printed — `formatReceiptDateTime` owns that, and pins
    // it — while the reader's line resolves the instant the clock landed on
    // rather than throwing.
    expect(
      receiptZone({
        viewerZone: "Australia/Brisbane",
        wallClock: "2026-03-08 02:30:00",
        zone: "America/New_York",
      })?.viewerTime
    ).toBe("5:30 pm your time");
  });
});

describe(withZoneLabel, () => {
  it("puts the city beside the date", () => {
    expect(withZoneLabel("16 Oct 2026", "Brisbane")).toBe(
      "16 Oct 2026 · Brisbane"
    );
  });

  it("leaves the date alone when there is no city to name", () => {
    // A receipt added from the reader's own zone, or stored before #200.
    expect(withZoneLabel("16 Oct 2026")).toBe("16 Oct 2026");
  });
});
