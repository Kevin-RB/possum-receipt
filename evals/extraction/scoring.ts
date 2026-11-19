import "temporal-polyfill/global";
import { reconcile } from "@/lib/receipt/integrity";

import type {
  CategorizationGoldenItem,
  CategorizationScores,
  Extraction,
  ExtractionScores,
  GoldenItem,
  GoldenReceipt,
  ItemMatch,
} from "./types";

type PredictedItem = Extraction["items"][number];

const round = (value: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/**
 * Lowercase, NFKC, then every run of punctuation/whitespace becomes one space.
 * Digits survive: `400GRAM` is part of a receipt item's identity.
 */
export const normaliseName = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Standard two-row Levenshtein distance. */
export const levenshtein = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  let current = Array.from({ length: right.length + 1 }, () => 0);

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution =
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1);
      current[column] = Math.min(
        previous[column] + 1,
        current[column - 1] + 1,
        substitution
      );
    }
    [previous, current] = [current, previous];
  }

  return previous[right.length];
};

/** `1 - distance / length`, on the normalised names. */
export const nameSimilarity = (left: string, right: string): number => {
  const a = normaliseName(left);
  const b = normaliseName(right);
  const longest = Math.max(a.length, b.length);
  if (longest === 0) {
    return 1;
  }
  return 1 - levenshtein(a, b) / longest;
};

export const NAME_SIMILARITY_THRESHOLD = 0.75;
export const AMOUNT_TOLERANCE = 0.01;

interface Candidate {
  goldenIndex: number;
  predictedIndex: number;
  similarity: number;
}

/**
 * Multiset matching, not index matching: the golden key's item order is the old
 * pipeline's insertion order, not the printed order. A pair may match only when
 * the line totals are within a cent and the names are at least 0.75 similar;
 * pairs are then taken greedily by similarity descending, one-to-one.
 */
export const matchItems = (
  goldenItems: GoldenItem[],
  predictedItems: PredictedItem[]
): ItemMatch => {
  const candidates: Candidate[] = [];

  for (const [goldenIndex, golden] of goldenItems.entries()) {
    for (const [predictedIndex, predicted] of predictedItems.entries()) {
      if (Math.abs(golden.lineTotal - predicted.lineTotal) > AMOUNT_TOLERANCE) {
        continue;
      }
      const similarity = nameSimilarity(golden.name, predicted.name);
      if (similarity < NAME_SIMILARITY_THRESHOLD) {
        continue;
      }
      candidates.push({ goldenIndex, predictedIndex, similarity });
    }
  }

  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.goldenIndex - right.goldenIndex ||
      left.predictedIndex - right.predictedIndex
  );

  const usedGolden = new Set<number>();
  const usedPredicted = new Set<number>();
  for (const candidate of candidates) {
    if (
      usedGolden.has(candidate.goldenIndex) ||
      usedPredicted.has(candidate.predictedIndex)
    ) {
      continue;
    }
    usedGolden.add(candidate.goldenIndex);
    usedPredicted.add(candidate.predictedIndex);
  }

  const matched = usedGolden.size;
  const predicted = predictedItems.length;
  const golden = goldenItems.length;
  let precision = predicted === 0 ? 0 : matched / predicted;
  if (predicted === 0 && golden === 0) {
    precision = 1;
  }
  const recall = golden === 0 ? 1 : matched / golden;
  const f1 =
    precision + recall === 0
      ? 0
      : (2 * precision * recall) / (precision + recall);

  return {
    f1: round(f1, 4),
    golden,
    matched,
    precision: round(precision, 4),
    predicted,
    recall: round(recall, 4),
    unmatchedGolden: goldenItems
      .map((_, index) => index)
      .filter((index) => !usedGolden.has(index)),
  };
};

/**
 * Parses a receipt wall clock, tolerating what models actually emit: a trailing
 * `Z` or offset, a space instead of `T`, no seconds, fractional seconds. A
 * date-only value parses as midnight, which is then wrong on hour and minute
 * rather than an exception.
 */
export const parseWallClock = (
  value: string | null | undefined
): Temporal.PlainDateTime | null => {
  if (value === null || value === undefined) {
    return null;
  }
  let text = value.trim();
  if (text === "") {
    return null;
  }

  text = text
    .replace(/\.\d+/u, "")
    .replace(/(?:Z|[+-]\d{2}:?\d{2})$/iu, "")
    .replace(
      /^(?<date>\d{4}-\d{2}-\d{2})[ T](?<time>\d{2}:\d{2})/u,
      "$<date>T$<time>"
    );

  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(text)) {
    text = `${text}:00`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    text = `${text}T00:00:00`;
  }

  try {
    return Temporal.PlainDateTime.from(text);
  } catch {
    return null;
  }
};

const sameMinute = (
  left: Temporal.PlainDateTime,
  right: Temporal.PlainDateTime
): boolean =>
  left.toPlainDate().equals(right.toPlainDate()) &&
  left.hour === right.hour &&
  left.minute === right.minute;

export const HALF_CENT = 0.005;

export const scoreExtraction = (
  golden: GoldenReceipt,
  extraction: Extraction
): ExtractionScores => {
  const lineItemMatch = matchItems(golden.items, extraction.items);
  const reconciliation = reconcile(
    extraction.items.map((item) => ({
      kind: item.kind,
      lineTotal: item.lineTotal,
    })),
    extraction.totals
  );

  const goldenDatetime = parseWallClock(golden.transactionDatetime);
  const predictedDatetime = parseWallClock(extraction.transaction.datetime);

  return {
    datetimeExact:
      goldenDatetime === null
        ? null
        : predictedDatetime !== null &&
          sameMinute(goldenDatetime, predictedDatetime),
    gstReported: typeof extraction.totals.gst === "number",
    lineItemF1: lineItemMatch.f1,
    lineItemMatch,
    paymentExact: extraction.payment.method === golden.paymentMethod,
    reconcileMatches: reconciliation.matches,
    schemaValid: true,
    totalExact: Math.abs(extraction.totals.total - golden.total) <= HALF_CENT,
  };
};

export const scoreCategorization = (
  golden: CategorizationGoldenItem[],
  predicted: (string | null)[]
): CategorizationScores => {
  let agreed = 0;
  const mismatches: CategorizationScores["mismatches"] = [];

  for (const [index, item] of golden.entries()) {
    const assigned = predicted[index] ?? null;
    if (assigned === item.categorySlug) {
      agreed += 1;
    } else {
      mismatches.push({
        golden: item.categorySlug,
        name: item.name,
        predicted: assigned,
      });
    }
  }

  return {
    agreed,
    agreement: golden.length === 0 ? 1 : round(agreed / golden.length, 4),
    mismatches,
    total: golden.length,
  };
};

/** A golden line as the dispute record shows it. */
export const describeGoldenItem = (item: GoldenItem): string =>
  `${item.name.trim()} @ ${item.lineTotal.toFixed(2)}`;
