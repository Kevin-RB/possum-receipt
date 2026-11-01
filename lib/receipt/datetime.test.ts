import { describe, expect, it } from "vitest";

import {
  compareWallClocks,
  formatReceiptDate,
  formatReceiptDateTime,
  instantToWallClock,
  plainDateToLocalDay,
  receiptDateTimeToWallClock,
  receiptDayToLocalString,
  receiptLocalStringToDay,
  receiptLocalStringToTime,
  tryWallClockToISODate,
  wallClockToISODate,
  wallClockToLocalString,
  wallClockToUTCDate,
} from "@/lib/receipt/datetime";
import { simulateBrowserWithPolyfilledTemporal } from "@/test/polyfilled-temporal";

/**
 * The manual edit form stores the transaction datetime as a bare local
 * wall-clock string (`YYYY-MM-DDTHH:mm`), while the calendar works in whole
 * calendar days. These conversions are the seam between the two, so they are
 * pinned here rather than in the component.
 *
 * The calendar day is a `Date` at the browser's local midnight holding the
 * receipt-local year/month/day, never the instant that day begins: reading the
 * day back off the instant would shift it by a day for any browser west of
 * Australia/Brisbane.
 */

describe(receiptLocalStringToDay, () => {
  simulateBrowserWithPolyfilledTemporal();

  it("reads a local datetime string as a calendar day", () => {
    const day = receiptLocalStringToDay("2026-06-15T14:32");

    expect(day).toBeInstanceOf(Date);
    expect([day?.getFullYear(), day?.getMonth(), day?.getDate()]).toStrictEqual(
      [2026, 5, 15]
    );
    expect(day?.getHours()).toBe(0);
  });

  it("ignores the time of day when reading the day", () => {
    const early = receiptLocalStringToDay("2026-06-15T00:01");
    const late = receiptLocalStringToDay("2026-06-15T23:59");

    expect(early?.getDate()).toBe(late?.getDate());
  });

  it("accepts a date-only string and a datetime with seconds", () => {
    expect(receiptLocalStringToDay("2026-06-15")).toStrictEqual(
      receiptLocalStringToDay("2026-06-15T00:00")
    );
    expect(receiptLocalStringToDay("2026-06-15T14:32:00")).toStrictEqual(
      receiptLocalStringToDay("2026-06-15T14:32")
    );
  });

  it("has no day for a missing or unparseable value", () => {
    // `""` stands in for the missing-value path: a receipt with no extracted
    // datetime carries no value, which the form renders the same way.
    expect(receiptLocalStringToDay("")).toBeUndefined();
    expect(receiptLocalStringToDay("2026")).toBeUndefined();
    expect(receiptLocalStringToDay("28/07/2026 6:51pm")).toBeUndefined();
  });

  it("rejects a date that does not exist rather than rolling it over", () => {
    expect(receiptLocalStringToDay("2026-13-45")).toBeUndefined();
    expect(receiptLocalStringToDay("2026-02-30")).toBeUndefined();
  });
});

describe(receiptLocalStringToTime, () => {
  it("reads the time of day as HH:mm", () => {
    expect(receiptLocalStringToTime("2026-06-15T14:32")).toBe("14:32");
  });

  it("keeps the time when the value carries seconds", () => {
    expect(receiptLocalStringToTime("2026-06-15T14:32:00")).toBe("14:32");
  });

  it("has no time for a missing, date-only or unparseable value", () => {
    expect(receiptLocalStringToTime("")).toBeUndefined();
    expect(receiptLocalStringToTime("2026-06-15")).toBeUndefined();
    expect(receiptLocalStringToTime("28/07/2026 6:51pm")).toBeUndefined();
  });

  it("rejects an out-of-range time rather than passing it through", () => {
    expect(receiptLocalStringToTime("2026-06-15T99:99")).toBeUndefined();
    expect(
      receiptLocalStringToTime("2026-06-15T14:32 trailing")
    ).toBeUndefined();
  });
});

describe(plainDateToLocalDay, () => {
  simulateBrowserWithPolyfilledTemporal();

  it("carries the date at the runtime's local midnight", () => {
    const day = plainDateToLocalDay(Temporal.PlainDate.from("2026-10-07"));

    expect([day.getFullYear(), day.getMonth(), day.getDate()]).toStrictEqual([
      2026, 9, 7,
    ]);
    expect(day.getHours()).toBe(0);
  });

  it("agrees with the cell the same day produces in the calendar", () => {
    // The bound and the cells the calendar draws must land on one day, or the
    // day a receipt was bought is unreachable in the date picker.
    const cell = receiptLocalStringToDay("2026-10-07T09:00");

    expect(cell).toStrictEqual(
      plainDateToLocalDay(Temporal.PlainDate.from("2026-10-07"))
    );
  });
});

describe(receiptDayToLocalString, () => {
  it("combines a calendar day with a time of day", () => {
    expect(receiptDayToLocalString(new Date(2026, 6, 20), "09:05")).toBe(
      "2026-07-20T09:05"
    );
  });

  it("falls back to midnight when no time is given", () => {
    expect(receiptDayToLocalString(new Date(2026, 6, 20))).toBe(
      "2026-07-20T00:00"
    );
  });

  it("pads single-digit months and days", () => {
    expect(receiptDayToLocalString(new Date(2026, 0, 5), "09:05")).toBe(
      "2026-01-05T09:05"
    );
  });

  it("falls back to midnight for a time that is not HH:mm", () => {
    expect(receiptDayToLocalString(new Date(2026, 6, 20), "9:05")).toBe(
      "2026-07-20T00:00"
    );
    expect(receiptDayToLocalString(new Date(2026, 6, 20), "noon")).toBe(
      "2026-07-20T00:00"
    );
  });

  it("round-trips a local datetime string through the calendar day", () => {
    const original = "2026-06-15T14:32";
    const day = receiptLocalStringToDay(original);

    if (!day) {
      throw new Error("expected a calendar day");
    }

    expect(
      receiptDayToLocalString(day, receiptLocalStringToTime(original))
    ).toBe(original);
  });
});

describe(formatReceiptDate, () => {
  it("renders the printed date without a time", () => {
    expect(formatReceiptDate("2026-05-17 14:00:00")).toBe(
      "Sunday, 17 May 2026"
    );
  });
});

describe(formatReceiptDateTime, () => {
  /**
   * Pinned deliberately. This string is rendered on the server and rendered
   * again by React during hydration, so a difference of one comma fails the
   * receipts page. The comma is also the exact character that disappears when a
   * `Temporal` object is handed to `Intl.DateTimeFormat#format` under Node, so
   * this test catches that regression rather than merely describing the format.
   */
  it("renders the receipt-local date and time identically on both runtimes", () => {
    expect(formatReceiptDateTime("2026-10-17 19:35:00")).toBe(
      "Saturday, 17 October 2026 at 7:35 pm"
    );
  });
});

describe(receiptDateTimeToWallClock, () => {
  it("keeps a bare wall clock as written", () => {
    expect(receiptDateTimeToWallClock("2026-07-28T18:51:00")).toBe(
      "2026-07-28 18:51:00"
    );
  });

  it("drops a numeric offset instead of converting", () => {
    // The printed time is the datum; an offset bolted onto it does not move it.
    expect(receiptDateTimeToWallClock("2026-07-28T18:51:00+10:00")).toBe(
      "2026-07-28 18:51:00"
    );
  });

  it("converts a UTC designator into the receipt timezone", () => {
    // The extraction contract forbids a `Z`, but a model that emits one is
    // describing an instant, not a printed time.
    expect(receiptDateTimeToWallClock("2026-07-28T08:51:00Z")).toBe(
      "2026-07-28 18:51:00"
    );
  });

  it("rejects a value that is not a date", () => {
    // The native and polyfilled implementations word this differently, so the
    // assertion matches the fragment both share rather than pinning one.
    expect(() => receiptDateTimeToWallClock("28/07/2026 6:51pm")).toThrow(
      /pars/iu
    );
  });
});

describe(wallClockToISODate, () => {
  it("reads the printed day from a Postgres timestamp", () => {
    expect(wallClockToISODate("2026-10-07 20:30:00")).toBe("2026-10-07");
  });

  it("accepts the form's representation", () => {
    expect(wallClockToISODate("2026-10-07T20:30")).toBe("2026-10-07");
  });

  it("has no day for an unparseable value", () => {
    expect(tryWallClockToISODate("not a date")).toBeUndefined();
  });
});

describe("the printed day", () => {
  /**
   * The regression this pins: the day used to be derived by converting the
   * stored instant in the *browser's* zone, so a 07:00 purchase landed on the
   * previous day for anyone west of Brisbane and a 23:00 purchase on the next
   * day for anyone east of it. The day is now read from the value, so the
   * runtime's zone cannot move it.
   */
  it("is the day on the receipt, whatever the runtime timezone", () => {
    expect(wallClockToISODate("2026-10-07 07:00:00")).toBe("2026-10-07");
    expect(wallClockToISODate("2026-10-07 23:00:00")).toBe("2026-10-07");
  });
});

describe(wallClockToLocalString, () => {
  it("renders the edit form's representation", () => {
    expect(wallClockToLocalString("2026-10-07 20:30:00")).toBe(
      "2026-10-07T20:30"
    );
  });

  it("drops seconds", () => {
    expect(wallClockToLocalString("2026-10-07T20:30:59")).toBe(
      "2026-10-07T20:30"
    );
  });
});

describe(wallClockToUTCDate, () => {
  /**
   * The carrier must not be built in the viewer's zone. `2026-03-08 02:30`
   * falls in America/New_York's spring-forward gap, where the local constructor
   * normalises it to 03:30 — a time the receipt does not say, and one the
   * server (Brisbane, no gap) would not render, so the hydrated string would
   * disagree with the server-rendered one.
   */
  it("carries the printed components at UTC", () => {
    expect(wallClockToUTCDate("2026-03-08 02:30:00").getTime()).toBe(
      Date.UTC(2026, 2, 8, 2, 30)
    );
  });

  it("renders a time that does not exist in a DST-gap zone", () => {
    expect(formatReceiptDateTime("2026-03-08 02:30:00")).toBe(
      "Sunday, 8 March 2026 at 2:30 am"
    );
  });
});

describe(instantToWallClock, () => {
  it("emits the stored representation, not a T-separated one", () => {
    expect(instantToWallClock(new Date("2026-10-07T10:30:00Z"))).toBe(
      "2026-10-07 20:30:00"
    );
  });
});

describe(compareWallClocks, () => {
  /**
   * The regression this pins: the receipts table compared these values as
   * strings, and `" "` < `"T"`, so an 08:00 value written with a `T` sorted
   * after a 09:35 value written with a space — the wrong end of the same day.
   */
  it("orders by value regardless of the separator", () => {
    expect(
      compareWallClocks("2026-10-16T08:00:00", "2026-10-16 09:35:00")
    ).toBeLessThan(0);
    expect(
      compareWallClocks("2026-10-16 09:35:00", "2026-10-16T08:00:00")
    ).toBeGreaterThan(0);
  });

  it("orders across days", () => {
    expect(
      compareWallClocks("2026-10-06 23:00:00", "2026-10-07 01:00:00")
    ).toBeLessThan(0);
  });

  it("treats the same wall clock written differently as equal", () => {
    expect(
      compareWallClocks("2026-10-16 08:00:00", "2026-10-16T08:00:00")
    ).toBe(0);
  });
});
