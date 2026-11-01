import "temporal-polyfill/global";

export const RECEIPT_TIMEZONE = "Australia/Brisbane";

const pad = (value: number) => value.toString().padStart(2, "0");

/**
 * A receipt's transaction datetime is the local date and time printed on the
 * paper. It has no timezone and no instant: it is stored in a `timestamp`
 * column (no time zone) and carried as a string — `2026-10-07 20:30:00` when
 * read back from Postgres, `2026-10-07T20:30` when it comes from a form or an
 * extraction. Both forms parse; nothing is converted between zones.
 *
 * Instants are still used for server events (`created_at`, `categorized_at`),
 * and `RECEIPT_TIMEZONE` survives to interpret a stray UTC designator and to
 * answer "what day is it now".
 */
export const wallClockToPlainDateTime = (
  value: string
): Temporal.PlainDateTime => Temporal.PlainDateTime.from(value);

export const wallClockToISODate = (value: string): string =>
  Temporal.PlainDateTime.from(value).toPlainDate().toString();

/**
 * `wallClockToISODate` for values the app does not own — a filter reading a
 * table cell, say. An unparseable value has no date rather than throwing a
 * render.
 */
export const tryWallClockToISODate = (value: string): string | undefined => {
  try {
    return wallClockToISODate(value);
  } catch {
    // An unparseable value has no date rather than throwing a render.
  }
};

/** The wall clock in the manual edit form's own representation. */
export const wallClockToLocalString = (value: string): string =>
  Temporal.PlainDateTime.from(value).toString({ smallestUnit: "minute" });

/**
 * Compares two wall clocks by value.
 *
 * The receipts table sorted this column with a plain string comparison, which
 * is chronological only while every value shares one format: a `T`-separated
 * value sorts after every space-separated one on the same day, because `" "`
 * < `"T"`, so a pending receipt fell to the bottom of its day. Parsing makes
 * the order independent of the separator and of the producer.
 */
export const compareWallClocks = (a: string, b: string): number =>
  Temporal.PlainDateTime.compare(
    Temporal.PlainDateTime.from(a),
    Temporal.PlainDateTime.from(b)
  );

/**
 * The stored representation: the text Postgres returns for a `timestamp`
 * (`2026-10-07 20:30:00`).
 *
 * Every value that reaches the client uses this separator — the form Postgres
 * returns and the one `receiptDateTimeToWallClock` normalises edited values to.
 * Ordering no longer depends on it: `compareWallClocks` parses both sides, so a
 * `T`-separated value would still land in the right place. The canonical form
 * is for consistency, not for chronological order.
 */
export const wallClockToString = (value: Temporal.PlainDateTime): string =>
  `${value.toPlainDate().toString()} ${pad(value.hour)}:${pad(value.minute)}:${pad(value.second)}`;

/**
 * Normalises an extracted or edited datetime into a wall clock.
 *
 * A numeric offset is dropped: `2026-07-28T18:51:00+10:00` is the printed local
 * time with an offset bolted on, so the wall clock is the time as written. A
 * UTC designator is an instant, which the extraction contract forbids; if a
 * model emits one anyway it is converted to the receipt timezone rather than
 * silently read as local time.
 */
export const receiptDateTimeToWallClock = (value: string): string => {
  const trimmed = value.trim();

  if (/[zZ]$/u.test(trimmed)) {
    return wallClockToString(
      Temporal.Instant.from(trimmed)
        .toZonedDateTimeISO(RECEIPT_TIMEZONE)
        .toPlainDateTime()
    );
  }

  return wallClockToString(Temporal.PlainDateTime.from(trimmed));
};

/**
 * The instant a wall clock names in a given timezone. Only needed where a
 * column is genuinely an instant — the fixture's `created_at`, for example —
 * never to derive a receipt's day.
 */
export const wallClockToInstant = (
  value: string,
  timezone = RECEIPT_TIMEZONE
): Date =>
  new Date(
    Temporal.PlainDateTime.from(value).toZonedDateTime(timezone, {
      disambiguation: "compatible",
    }).epochMilliseconds
  );

export const instantToWallClock = (
  date: Date,
  timezone = RECEIPT_TIMEZONE
): string =>
  wallClockToString(
    Temporal.Instant.fromEpochMilliseconds(date.getTime())
      .toZonedDateTimeISO(timezone)
      .toPlainDateTime()
  );

/**
 * The formatters take the wall clock and render it as written.
 *
 * They build a `Date` at *UTC* holding the receipt's own year/month/day/time,
 * and every formatter reads it back in UTC, so the runtime reproduces exactly
 * those components. Building the `Date` in the viewer's local zone instead
 * would make the output depend on that zone: a printed time that falls in a
 * spring-forward gap — `2026-03-08 02:30` in `America/New_York` — normalises
 * to 03:30 locally, so the table would show an hour the receipt does not say,
 * and the server-rendered string (Brisbane has no such gap) would not match the
 * hydrated one.
 *
 * The `Date` itself is still required: handing the `Temporal` object to `Intl`
 * directly is not portable — with en-AU `dateStyle: "full"`, Node's native
 * bridge drops the comma after the weekday ("Saturday 17 October 2026") while
 * the browser keeps it ("Saturday, 17 October 2026"), which is a hydration
 * error on every receipts page.
 */
export const wallClockToUTCDate = (value: string): Date => {
  const { day, hour, minute, month, year } = Temporal.PlainDateTime.from(value);
  return new Date(Date.UTC(year, month - 1, day, hour, minute));
};

const RECEIPT_DATE_TIME_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "full",
  timeStyle: "short",
  timeZone: "UTC",
});

const RECEIPT_DATE_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "full",
  timeZone: "UTC",
});

const RECEIPT_SHORT_DATE_FORMATTER = new Intl.DateTimeFormat("en-AU", {
  dateStyle: "medium",
  timeZone: "UTC",
});

/** The receipt's printed date and time, for prose and the edit form. */
export const formatReceiptDateTime = (value: string): string =>
  RECEIPT_DATE_TIME_FORMATTER.format(wallClockToUTCDate(value));

/** The receipt's printed date, without a time. */
export const formatReceiptDate = (value: string): string =>
  RECEIPT_DATE_FORMATTER.format(wallClockToUTCDate(value));

/** A compact date for the receipts table's phone cards. */
export const formatReceiptShortDate = (value: string): string =>
  RECEIPT_SHORT_DATE_FORMATTER.format(wallClockToUTCDate(value));

/**
 * The transaction datetime is held as a bare local wall-clock string, the
 * form's own representation. A calendar picks whole days and cannot represent a
 * time of day, so these conversions are the seam between the two halves of the
 * manual edit form.
 *
 * A day is carried as a `Date` at the browser's local midnight holding the
 * receipt-local year/month/day — never the instant that day begins. Reading the
 * day back off an instant would shift it by one for any browser west of
 * Australia/Brisbane, so the local components are read directly.
 */

const LOCAL_STRING_PATTERN =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})(?:[T ](?<hour>\d{2}):(?<minute>\d{2})(?::\d{2})?)?$/u;

const parseLocalString = (localString: string | undefined) =>
  LOCAL_STRING_PATTERN.exec(localString ?? "")?.groups;

const tryParse = <T>(parse: () => T): T | undefined => {
  try {
    return parse();
  } catch {
    // Falls through to undefined, the same answer as a value that did not
    // parse at all.
  }
};

export const receiptLocalStringToDay = (
  localString: string | undefined
): Date | undefined => {
  const parts = parseLocalString(localString);

  if (!parts?.year || !parts.month || !parts.day) {
    return;
  }

  // Temporal validates the parts: `new Date(2026, 12, 45)` would silently roll
  // over into 2027, so a date that does not exist is caught here instead.
  const plainDate = tryParse(() =>
    Temporal.PlainDate.from(`${parts.year}-${parts.month}-${parts.day}`)
  );

  if (!plainDate) {
    return;
  }

  const { day, month, year } = plainDate;
  return new Date(year, month - 1, day);
};

const HOUR_MINUTE_PATTERN = /^(?<hour>\d{2}):(?<minute>\d{2})$/u;

const MAX_HOUR = 23;
const MAX_MINUTE = 59;

/** Reads a time of day, rejecting `99:99` and anything else off the clock. */
const normalizeTimeOfDay = (time: string | undefined) => {
  const match = HOUR_MINUTE_PATTERN.exec(time ?? "");
  const { hour, minute } = match?.groups ?? {};

  return Number(hour) <= MAX_HOUR && Number(minute) <= MAX_MINUTE
    ? `${hour}:${minute}`
    : undefined;
};

export const receiptLocalStringToTime = (
  localString: string | undefined
): string | undefined => {
  const { hour, minute } = parseLocalString(localString) ?? {};
  return normalizeTimeOfDay(hour && minute ? `${hour}:${minute}` : undefined);
};

/** The ISO date of a calendar day carried at browser-local midnight. */
export const localDayToISODate = (day: Date): string =>
  `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;

/**
 * The last day a receipt transaction datetime may fall on: today in the
 * receipt's own timezone, carried the same way `receiptLocalStringToDay`
 * carries a day — a `Date` at the browser's local midnight holding the
 * receipt-local year/month/day.
 *
 * This must be built in the receipt timezone rather than from `new Date()`.
 * A calendar compares its cells (receipt-local days) against this bound, so a
 * browser whose own clock is behind Brisbane reads "today" as tomorrow and
 * would disable the very day a receipt was bought.
 */
export const receiptToday = (
  timezone = RECEIPT_TIMEZONE,
  now: Temporal.Instant | Date = Temporal.Now.instant()
): Date => {
  const instant =
    now instanceof Date
      ? Temporal.Instant.fromEpochMilliseconds(now.getTime())
      : now;
  const { day, month, year } = instant
    .toZonedDateTimeISO(timezone)
    .toPlainDate();
  return new Date(year, month - 1, day);
};

/**
 * Combines a calendar day with a time of day. A time that is absent or not a
 * valid time of day falls back to midnight: both inputs come from a date or
 * time input, so anything else is malformed and midnight beats emitting an
 * unparseable value.
 */
export const receiptDayToLocalString = (day: Date, time?: string): string =>
  `${localDayToISODate(day)}T${normalizeTimeOfDay(time) ?? "00:00"}`;
