import "temporal-polyfill/global";
import { isTimezone } from "@/lib/time";

/**
 * What a receipt's recorded zone adds to its printed clock.
 *
 * The printed time is the datum (ADR-0015) and is never restated here: this
 * answers only "where was this added from", and "what does that moment read on
 * the reader's own clock". Nothing in it can move the receipt to another day.
 */
export interface ReceiptZone {
  /** Whether the receipt was added from somewhere other than the reader's zone. */
  differs: boolean;
  /** The city in the IANA name: `Brisbane` for `Australia/Brisbane`. */
  label: string;
  /**
   * The same moment on the reader's clock, only when the zones differ. Carries
   * its own day when the two land on different days, so a reader west of the
   * printer is not told "6:35 pm" of a day they are not on.
   */
  viewerTime?: string;
  /** The IANA zone the receipt was added from. */
  zone: string;
}

/** `America/New_York` reads as "New York"; a zone with no region reads as itself. */
const labelOf = (zone: string): string =>
  zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;

const timeFormatter = (zone: string) =>
  new Intl.DateTimeFormat("en-AU", { timeStyle: "short", timeZone: zone });

/**
 * "Fri 16 Oct", assembled from parts rather than formatted whole.
 *
 * A whole format inserts locale punctuation between the weekday and the date
 * ("Fri, 16 Oct"), and ICU versions disagree about which punctuation — the same
 * class of mismatch `lib/receipt/datetime.ts` documents for full dates, which is
 * a hydration error when the server and the browser render different strings.
 */
const dayFormatter = (zone: string) =>
  new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: zone,
    weekday: "short",
  });

const dayLabel = (zone: string, at: Date): string => {
  const parts = dayFormatter(zone).formatToParts(at);
  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return [valueOf("weekday"), valueOf("day"), valueOf("month")]
    .filter(Boolean)
    .join(" ");
};

/**
 * The form renders this from a value the user is still editing, so an
 * unreadable wall clock is answered rather than thrown.
 */
const parseWallClock = (value: string): Temporal.PlainDateTime | undefined => {
  try {
    return Temporal.PlainDateTime.from(value);
  } catch {
    // Mid-edit or empty: nothing to caption yet.
  }
};

/**
 * The caption for a receipt, or `undefined` when it has no usable zone.
 *
 * `zone` is a column filled from a browser, so it can hold anything: a value
 * that names no zone is treated exactly like a receipt stored before #200 had
 * one, and renders as it always did.
 *
 * A printed time that a spring-forward gap skipped (`02:30` in a zone that
 * jumped to `03:30`) resolves to the instant the clock landed on. The printed
 * value is untouched — it is the paper's, not the zone's.
 */
export const receiptZone = ({
  viewerZone,
  wallClock,
  zone,
}: {
  viewerZone: string;
  wallClock: string;
  zone: string | null | undefined;
}): ReceiptZone | undefined => {
  if (!isTimezone(zone)) {
    return;
  }

  const printed = parseWallClock(wallClock);
  if (!printed) {
    return;
  }

  const zoned = printed.toZonedDateTime(zone, {
    disambiguation: "compatible",
  });
  const instant = Temporal.Instant.fromEpochMilliseconds(
    zoned.epochMilliseconds
  );
  const at = new Date(zoned.epochMilliseconds);
  const differs = zone !== viewerZone;

  if (!differs) {
    return { differs, label: labelOf(zone), zone };
  }

  const viewerDate = instant.toZonedDateTimeISO(viewerZone).toPlainDate();
  const sameDay =
    Temporal.PlainDate.compare(viewerDate, printed.toPlainDate()) === 0;
  const day = sameDay ? "" : `${dayLabel(viewerZone, at)} `;

  return {
    differs,
    label: labelOf(zone),
    viewerTime: `${timeFormatter(viewerZone).format(at)} ${day}your time`,
    zone,
  };
};

/**
 * A date with its city beside it: `16 Oct 2026 · Brisbane`, or the date alone
 * when the receipt was added from the reader's own zone, or before the column
 * existed. Every surface that shows a date uses this, so the separator and the
 * "only when it differs" rule are stated once.
 */
export const withZoneLabel = (date: string, zoneLabel?: string): string =>
  zoneLabel ? `${date} · ${zoneLabel}` : date;
