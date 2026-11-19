import type { ReceiptInformationExtraction } from "@/lib/db/contract";

/** The production extraction contract, which is what every variant is scored against. */
export type Extraction = ReceiptInformationExtraction;

export interface CorpusEntry {
  bytes: number;
  height: number;
  id: string;
  imagePath: string;
  merchant: string;
  objectKey: string;
  sha256: string;
  total: number;
  transactionDatetime: string | null;
  width: number;
}

export interface GoldenItem {
  kind: string;
  lineTotal: number;
  name: string;
  quantity: number | null;
  unitPrice: number | null;
}

/**
 * The draft answer key, as written by `golden.draft.json`. Its provenance is the
 * old pipeline's rows, so it encodes that pipeline's mistakes: `gst` is null on
 * every receipt, item order is insertion order, and four discrepancies against
 * the paper are documented in the input README. A model that reads the paper
 * correctly is *supposed* to disagree with it, which is what `disputes.json`
 * exists to show.
 */
export interface GoldenReceipt {
  gst: number | null;
  hasIntegrityWarning: boolean;
  id: string;
  items: GoldenItem[];
  merchantAbn: string | null;
  merchantAddress: string | null;
  merchantName: string;
  merchantStoreId: string | null;
  paymentMethod: string;
  receiptNumber: string | null;
  subtotal: number | null;
  total: number;
  transactionDatetime: string | null;
}

export interface CategorizationGoldenItem {
  categorySlug: string;
  kind: string;
  name: string;
}

/** OpenRouter routing. `fp8` admits only fp8/bf16 endpoints, `free` adds nothing. */
export type Routing = "free" | "fp8";

export type VariantKind = "A" | "B" | "C" | "D";

export const extractionVariants = [
  "A-free",
  "A-fp8",
  "B-fp8",
  "C-fp8",
] as const;

export type ExtractionVariant = (typeof extractionVariants)[number];

export type Variant = ExtractionVariant | "D";

export interface VariantSpec {
  kind: VariantKind;
  routing: Routing;
}

export const VARIANT_SPECS: Record<ExtractionVariant, VariantSpec> = {
  "A-fp8": { kind: "A", routing: "fp8" },
  "A-free": { kind: "A", routing: "free" },
  "B-fp8": { kind: "B", routing: "fp8" },
  "C-fp8": { kind: "C", routing: "fp8" },
};

/** One HTTP call that reached OpenRouter, including a call that failed. */
export interface CallRecord {
  cost: number | null;
  /** The failure text when the call threw, `null` when it returned. */
  error: string | null;
  /** `providerMetadata.openrouter.provider`, the host that served it. */
  host: string | null;
  inputTokens: number | null;
  latencyMs: number;
  outputTokens: number | null;
}

/** Accumulates every call a single run makes, so a failed attempt is still counted. */
export interface Meter {
  calls: CallRecord[];
}

export interface ItemMatch {
  f1: number;
  golden: number;
  matched: number;
  precision: number;
  predicted: number;
  recall: number;
  /** Golden item indexes no predicted item matched, for the dispute record. */
  unmatchedGolden: number[];
}

export interface ExtractionScores {
  /** `null` when the golden key has no value to compare against. */
  datetimeExact: boolean | null;
  gstReported: boolean;
  lineItemF1: number | null;
  lineItemMatch: ItemMatch | null;
  paymentExact: boolean | null;
  reconcileMatches: boolean | null;
  schemaValid: boolean;
  totalExact: boolean | null;
}

export interface CategorizationMismatch {
  golden: string;
  name: string;
  predicted: string | null;
}

export interface CategorizationScores {
  agreed: number;
  agreement: number;
  mismatches: CategorizationMismatch[];
  total: number;
}

export interface ErrorDetail {
  message: string;
  name: string;
  /** The raw model text behind a `NoObjectGeneratedError`, truncated. */
  rawText?: string;
  responseBody?: string;
  statusCode?: number;
  url?: string;
}

export interface RunRecord {
  calls: CallRecord[];
  /** Variant D only: the slug assigned to each golden item, in golden order. */
  categories: (string | null)[] | null;
  categorization: CategorizationScores | null;
  cost: number | null;
  error: ErrorDetail | null;
  extraction: Extraction | null;
  /** The first host observed, for the one-line report. */
  host: string | null;
  hosts: string[];
  inputTokens: number | null;
  latencyMs: number;
  outputTokens: number | null;
  /** The corpus receipt id, or `categorization` for variant D. */
  receiptId: string;
  run: number;
  scores: ExtractionScores | null;
  /** True when a schema rejection forced this run onto `structuredOutputs: strict false`. */
  strictFallback: boolean;
  transcript: string | null;
  variant: Variant;
}

export type RunIndex = Record<Variant, Record<string, RunRecord[]>>;

export interface SpendSummary {
  aborted: boolean;
  reason: string | null;
  totalUsd: number;
}

/** A scalar as disputes compare it: a trimmed string, a number to the cent, or null. */
export type ScalarValue = string | number | null;

export interface DisputeObservation {
  count: number;
  value: ScalarValue;
  /** How many observations came from each variant, e.g. `{ "A-free": 3 }`. */
  variants: Record<string, number>;
}

export interface FieldDispute {
  /** True when any observed value differs from the golden one. */
  disputed: boolean;
  golden: ScalarValue;
  observed: DisputeObservation[];
  /** Always null: this harness lists disagreements; it does not rule on them. */
  proposed: null;
}

export interface ItemDisputeRun {
  matchedCount: number;
  predictedCount: number;
  run: number;
  unmatchedGolden: string[];
  variant: ExtractionVariant;
}

export interface ItemDispute {
  runs: ItemDisputeRun[];
  /** Every golden line unmatched in at least one run. */
  unmatchedGolden: string[];
}

export interface ReceiptDisputes {
  fields: Record<string, FieldDispute>;
  /** Present only when no run reproduced the golden item multiset. */
  items: ItemDispute | null;
  merchant: string;
  receiptId: string;
}

export interface DisputesFile {
  fields: string[];
  generatedAt: string;
  receipts: ReceiptDisputes[];
}

export interface VariantSummary {
  costs: number[];
  datetimeExact: number;
  datetimeScored: number;
  f1Sum: number;
  hosts: Record<string, number>;
  latencies: number[];
  meanCost: number | null;
  meanF1: number | null;
  p50LatencyMs: number;
  paymentExact: number;
  reconcilePass: number;
  runs: number;
  schemaValid: number;
  totalExact: number;
  variant: Variant;
}

export interface RunsFile {
  generatedAt: string;
  model: string;
  runsPerReceipt: number;
  spend: SpendSummary;
  strictOutputs: boolean;
  /** Keyed by variant, then receipt id (`categorization` for D). */
  runs: RunIndex;
}
