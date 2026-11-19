import {
  formatLatency,
  formatUsd,
  markdownTable,
  VARIANT_TABLE_HEADERS,
  variantTableRows,
} from "./reporting";
import {
  describeLine,
  emptyMetrics,
  meanOf,
  RESCORE_FIELDS,
} from "./rescore-metrics";
import type {
  FieldCounts,
  MetricNumbers,
  RescoreReport,
  RescoreSummary,
} from "./rescore-metrics";
import type { DisputesFile, ExtractionVariant, GoldenItem } from "./types";
import { extractionVariants } from "./types";

/* -------------------------------------------------------------------------- */
/* summary.md                                                                 */
/* -------------------------------------------------------------------------- */

const count = (numerator: number, denominator: number): string =>
  `${numerator}/${denominator}`;

const ratio = (sum: number, runs: number): string => {
  const value = meanOf(sum, runs);
  return value === null ? "—" : value.toFixed(3);
};

const fieldCell = (counts: FieldCounts): string =>
  counts.scored === 0 ? "—" : count(counts.exact, counts.scored);

const dateCell = (metrics: MetricNumbers): string =>
  metrics.datetime.scored === 0
    ? "—"
    : `${count(metrics.datetime.exact, metrics.datetime.scored)}${
        metrics.datetime.scored < metrics.runs
          ? ` (${metrics.runs - metrics.datetime.scored} unscored)`
          : ""
      }`;

const dateOnlyCell = (metrics: MetricNumbers): string =>
  metrics.date.scored === 0
    ? "—"
    : count(metrics.date.exact, metrics.date.scored);

const recordedIds = (report: RescoreReport) => {
  const labels = new Map(report.receipts.map((r) => [r.id, r.label]));
  return (ids: string[]): string =>
    ids.length === 0
      ? "none"
      : ids.map((id) => labels.get(id) ?? id).join(", ");
};

const lossesSection = (report: RescoreReport): string => {
  const blocks: string[] = [];
  let clean = 0;
  for (const receipt of report.receipts) {
    for (const variant of extractionVariants) {
      const { runs, metrics } = receipt.variants[variant];
      if (runs.length === 0) {
        continue;
      }
      const failed = runs.filter((run) => run.failed).length;
      const lost = runs.filter(
        (run) =>
          run.failed ||
          run.unmatchedGolden.length > 0 ||
          run.unmatchedPredicted.length > 0
      );
      if (lost.length === 0) {
        clean += 1;
        continue;
      }
      const lines = lost.map((run) => {
        const missed = run.unmatchedGolden.map(describeLine);
        const spare = run.unmatchedPredicted.map(describeLine);
        const parts: string[] = [];
        if (failed > 0 && run.failed) {
          parts.push("the run failed");
        }
        if (missed.length > 0) {
          parts.push(
            `missed ${missed.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        if (spare.length > 0) {
          parts.push(
            `left over ${spare.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        return `  - run ${run.record.run}: ${parts.join("; ")}`;
      });
      blocks.push(
        [
          `**${receipt.label} · ${variant}** — mean F1 ${ratio(
            metrics.f1Sum,
            metrics.runs
          )}, amount F1 ${ratio(metrics.amountF1Sum, metrics.runs)}${
            failed > 0 ? `, ${failed} failed` : ""
          }`,
          ...lines,
        ].join("\n")
      );
    }
  }
  const note =
    clean === 0
      ? ""
      : `Every golden line matched in every run for the other ${clean} receipt × variant pairs.\n\n`;
  return `${note}${blocks.join("\n\n")}`;
};

const moneyLossTable = (report: RescoreReport): string => {
  const rows: string[][] = [];
  for (const receipt of report.receipts) {
    for (const variant of extractionVariants) {
      for (const run of receipt.variants[variant].runs) {
        if (run.amountUnmatchedGolden.length === 0) {
          continue;
        }
        rows.push([
          receipt.label,
          variant,
          `${run.record.run}`,
          run.amountUnmatchedGolden.map(describeLine).join(", "),
          run.amountUnmatchedPredicted.map(describeLine).join(", ") || "—",
        ]);
      }
    }
  }
  return rows.length === 0
    ? "No run missed a golden amount."
    : markdownTable(
        [
          "receipt",
          "variant",
          "run",
          "golden line missed",
          "predicted line left over",
        ],
        rows
      );
};

const categorizationSection = (report: RescoreReport): string => {
  const section = report.categorization;
  if (section === null) {
    return "## Categorization (variant D)\n\nNo categorization runs recorded.\n";
  }

  const rows = section.runs.map((run) => [
    `${run.run}`,
    count(run.agreed, run.total),
    run.agreement.toFixed(3),
    `${run.calls}`,
    formatUsd(run.cost),
    formatLatency(run.latencyMs),
  ]);
  const mismatchRows = section.mismatches.map((entry) => [
    entry.name,
    entry.golden,
    entry.predicted ?? "null",
    `${entry.count}`,
  ]);

  return [
    "## Categorization (variant D)",
    "",
    "Agreement is exact slug equality, re-scored with `scoreCategorization` where the predicted slugs are recorded.",
    "",
    `Mean agreement: **${section.meanAgreement === null ? "—" : section.meanAgreement.toFixed(3)}** over ${section.runs.length} runs.`,
    "",
    markdownTable(
      ["run", "agreement", "ratio", "calls", "cost", "latency"],
      rows
    ),
    "",
    mismatchRows.length === 0
      ? "Every item agreed with the owner's slug in every run."
      : [
          "Repeated disagreements (a slug that differs from the owner's label):",
          "",
          markdownTable(
            ["item", "owner slug", "predicted slug", "occurrences"],
            mismatchRows
          ),
        ].join("\n"),
    "",
  ].join("\n");
};

export const buildRescoreMarkdown = (report: RescoreReport): string => {
  const label = recordedIds(report);
  const dateOnly = report.key.dateOnly.map((id) => label([id]));
  const gstIds = report.key.gst.map((id) => label([id]));
  const gstReceipts = report.key.gst.length;

  const header = [
    `# Extraction re-score — ${report.label}`,
    "",
    `Generated ${report.generatedAt}. This is a re-score, not a run: \`${report.runsFilePath}\` was read and its extraction records were re-scored. No model was called and no network request was made.`,
    "",
    `Runs recorded ${report.runsGeneratedAt} against \`${report.model}\`, ${report.runsPerReceipt} runs per receipt per variant, ${report.receipts.length} receipts.`,
    "",
    `Answer key: \`${report.goldenFilePath}\`.`,
    "",
    "Scoring is the matrix's own code — `scoreExtraction` for A/B/C and `scoreCategorization` for D — so a number moves only because the key moved. Three policies apply:",
    "",
    `- A golden \`transactionDatetime\` with no clock time (\`YYYY-MM-DD\`) is **date-only**: ${dateOnly.length === 0 ? "no receipt in this key is date-only" : `${dateOnly.join(", ")} ${dateOnly.length === 1 ? "is" : "are"} scored on date equality in \`date exact\` and left out of \`datetime exact\``}.`,
    `- \`gst\` exactness is scored only over receipts whose golden \`gst\` is non-null — ${gstReceipts === 0 ? "none here" : `${gstIds.join(", ")}, so its denominator is ${gstReceipts} × ${report.runsPerReceipt} runs per variant`}.`,
    "- A failed run counts as zero in every pass rate and as zero in the mean F1.",
    "",
  ].join("\n");

  const variantTable = markdownTable(
    VARIANT_TABLE_HEADERS,
    variantTableRows(report.runs)
  );

  const datesTable = markdownTable(
    ["variant", "datetime exact", "date exact"],
    extractionVariants.map((variant) => {
      const metrics = report.numbers[variant];
      return [variant, dateCell(metrics), dateOnlyCell(metrics)];
    })
  );

  const itemRows = extractionVariants.map((variant) => {
    const metrics = report.numbers[variant];
    return [
      variant,
      ratio(metrics.f1Sum, metrics.runs),
      ratio(metrics.amountPrecisionSum, metrics.runs),
      ratio(metrics.amountRecallSum, metrics.runs),
      ratio(metrics.amountF1Sum, metrics.runs),
      metrics.nameMatched === 0
        ? "—"
        : count(metrics.nameExact, metrics.nameMatched),
    ];
  });

  const fieldRows = extractionVariants.map((variant) => {
    const metrics = report.numbers[variant];
    return [
      variant,
      fieldCell(metrics.fields.merchantName),
      fieldCell(metrics.fields.merchantAbn),
      fieldCell(metrics.fields.merchantStoreId),
      fieldCell(metrics.fields.receiptNumber),
      fieldCell(metrics.fields.subtotal),
      fieldCell(metrics.fields.gst),
    ];
  });

  const gstRows = report.receipts.map((receipt) => [
    receipt.label,
    ...extractionVariants.map((variant) => {
      const { metrics } = receipt.variants[variant];
      return count(metrics.gstReported, metrics.runs);
    }),
  ]);

  const perReceiptRows = report.receipts.flatMap((receipt) =>
    extractionVariants.map((variant) => {
      const { metrics } = receipt.variants[variant];
      return [
        receipt.label,
        receipt.merchant,
        variant,
        count(metrics.totalExact, metrics.runs),
        dateCell(metrics),
        dateOnlyCell(metrics),
        count(metrics.paymentExact, metrics.runs),
        ratio(metrics.f1Sum, metrics.runs),
        ratio(metrics.amountF1Sum, metrics.runs),
        metrics.nameMatched === 0
          ? "—"
          : count(metrics.nameExact, metrics.nameMatched),
        count(metrics.reconcilePass, metrics.runs),
      ];
    })
  );

  const reproduction = report.comparison;

  return [
    header,
    "## Variants",
    "",
    variantTable,
    "",
    "`datetime exact` excludes runs where the golden key has no date, and every date-only receipt. A failed run counts against every pass rate and as zero in the mean F1.",
    "",
    "## Dates",
    "",
    datesTable,
    "",
    "`date exact` is the date-only column: the prediction must carry the golden day, and any clock time is ignored because the paper prints none.",
    "",
    "## Line items",
    "",
    markdownTable(
      [
        "variant",
        "mean F1",
        "amount precision",
        "amount recall",
        "amount F1",
        "name exact",
      ],
      itemRows
    ),
    "",
    "`mean F1` is the matrix's metric: amount within a cent and names at least 0.75 similar. `amount` ignores names entirely — the same `kind` and the same magnitude — so it measures money accuracy alone, and a name-only disagreement passes it. `name exact` counts matched pairs whose names are identical after `normaliseName`, out of the pairs that matched.",
    "",
    "## Fields",
    "",
    markdownTable(
      [
        "variant",
        "merchantName",
        "merchantAbn",
        "merchantStoreId",
        "receiptNumber",
        "subtotal",
        "gst",
      ],
      fieldRows
    ),
    "",
    "Each cell is exact reads over the runs that scored. `merchantName` ignores case and whitespace, `merchantAbn` compares digits only, and the rest are exact after trimming with an empty string read as null. Only `gst` restricts its denominator to receipts the key has a value for; for the others a null golden value is a scored answer, so reporting a value the paper does not print is a miss.",
    "",
    "## GST reported",
    "",
    markdownTable(["receipt", ...extractionVariants], gstRows),
    "",
    "How many of the runs returned a numeric `gst` at all, whatever the amount — the count the field table cannot show, since a wrong GST and no GST both fail.",
    "",
    "## Per receipt",
    "",
    markdownTable(
      [
        "receipt",
        "merchant",
        "variant",
        "total exact",
        "datetime exact",
        "date exact",
        "payment exact",
        "mean F1",
        "amount F1",
        "name exact",
        "reconcile",
      ],
      perReceiptRows
    ),
    "",
    "Receipts are labelled by the first eight characters of their id; the key's own `merchantName` is beside it.",
    "",
    "## Remaining losses",
    "",
    lossesSection(report),
    "",
    "## Money-only losses",
    "",
    "The same check with names ignored: a golden line whose `kind` and magnitude no predicted line matched. What is left here is a missing, duplicated or wrong amount (or a wrong `kind`), never a formatting difference.",
    "",
    moneyLossTable(report),
    "",
    categorizationSection(report),
    "## Reproduction",
    "",
    reproduction === null
      ? "No comparison against `runs.json` was recorded."
      : `${reproduction.records} extraction records were re-scored; ${reproduction.differing} of them now carry a different metric set than \`runs.json\` records. Against the key the matrix scored, that count is zero.`,
    "",
  ].join("\n");
};

/* -------------------------------------------------------------------------- */
/* DELTA.md                                                                   */
/* -------------------------------------------------------------------------- */

const KEY_FIELDS = [
  "merchantName",
  "merchantAbn",
  "merchantAddress",
  "merchantStoreId",
  "transactionDatetime",
  "receiptNumber",
  "paymentMethod",
  "subtotal",
  "gst",
  "total",
  "hasIntegrityWarning",
] as const;

const show = (value: string | number | boolean | null): string => {
  if (value === null) {
    return "null";
  }
  return typeof value === "string" ? `"${value}"` : String(value);
};

const itemLabel = (item: GoldenItem): string =>
  `${item.name.trim()} @ ${item.lineTotal.toFixed(2)}`;

const changedQuantities = (
  before: GoldenItem[],
  after: GoldenItem[]
): boolean => {
  const previous = new Map(before.map((item) => [itemLabel(item), item]));
  for (const item of after) {
    const was = previous.get(itemLabel(item));
    if (
      was &&
      (was.quantity !== item.quantity || was.unitPrice !== item.unitPrice)
    ) {
      return true;
    }
  }
  return false;
};

const keyChanges = (
  baseline: RescoreSummary,
  current: RescoreSummary
): string[][] => {
  const previous = new Map(
    baseline.receipts.map((receipt) => [receipt.id, receipt])
  );
  const rows: string[][] = [];
  for (const receipt of current.receipts) {
    const before = previous.get(receipt.id);
    if (!before) {
      rows.push([receipt.label, "not in the baseline key", "—", "—"]);
      continue;
    }
    const changes: string[] = [];
    for (const field of KEY_FIELDS) {
      if (before.key[field] !== receipt.key[field]) {
        changes.push(
          `${field}: ${show(before.key[field])} → ${show(receipt.key[field])}`
        );
      }
    }
    const beforeItems = new Map(
      before.key.items.map((item) => [itemLabel(item), item])
    );
    const afterItems = new Map(
      receipt.key.items.map((item) => [itemLabel(item), item])
    );
    const removed = [...beforeItems.keys()].filter(
      (label) => !afterItems.has(label)
    );
    const added = [...afterItems.keys()].filter(
      (label) => !beforeItems.has(label)
    );
    const itemSummary = `${before.key.items.length} → ${receipt.key.items.length} lines`;
    for (const label of removed) {
      changes.push(`line removed: \`${label}\``);
    }
    for (const label of added) {
      changes.push(`line added: \`${label}\``);
    }
    if (changedQuantities(before.key.items, receipt.key.items)) {
      changes.push("a line's quantity or unit price changed");
    }
    rows.push([
      receipt.label,
      changes.length === 0 ? "unchanged" : changes.join("; "),
      itemSummary,
      before.key.transactionDatetime === receipt.key.transactionDatetime
        ? show(receipt.key.transactionDatetime)
        : `${show(before.key.transactionDatetime)} → ${show(receipt.key.transactionDatetime)}`,
    ]);
  }
  return rows;
};

interface DeltaCell {
  after: string;
  before: string;
  delta: string;
}

const signed = (value: number, places: number): string => {
  const text = value.toFixed(places);
  return value >= 0 ? `+${text}` : text;
};

const countDelta = (
  before: { exact: number; scored: number },
  after: { exact: number; scored: number }
): DeltaCell => ({
  after: `${after.exact}/${after.scored}`,
  before: `${before.exact}/${before.scored}`,
  delta:
    before.scored === after.scored
      ? signed(after.exact - before.exact, 0)
      : `${signed(after.exact - before.exact, 0)}, scored ${before.scored}→${after.scored}`,
});

const ratioDelta = (
  before: number | null,
  after: number | null
): DeltaCell => ({
  after: after === null ? "—" : after.toFixed(3),
  before: before === null ? "—" : before.toFixed(3),
  delta: before === null || after === null ? "—" : signed(after - before, 3),
});

const cell = (value: DeltaCell): string =>
  `${value.before} → ${value.after} (${value.delta})`;

const meanRatio = (sum: number, runs: number): number | null =>
  runs === 0 ? null : sum / runs;

const metricsOf = (
  summary: RescoreSummary,
  column: "overall" | ExtractionVariant
): MetricNumbers =>
  column === "overall"
    ? summary.overall
    : (summary.variants[column] ?? emptyMetrics());

const deltaRows = (
  baseline: RescoreSummary,
  current: RescoreSummary
): string[][] => {
  const columns: ("overall" | ExtractionVariant)[] = [
    ...extractionVariants,
    "overall",
  ];
  const definitions: {
    label: string;
    build: (before: MetricNumbers, after: MetricNumbers) => DeltaCell;
  }[] = [
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.f1Sum, before.runs),
          meanRatio(after.f1Sum, after.runs)
        ),
      label: "mean F1",
    },
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.amountPrecisionSum, before.runs),
          meanRatio(after.amountPrecisionSum, after.runs)
        ),
      label: "amount precision",
    },
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.amountRecallSum, before.runs),
          meanRatio(after.amountRecallSum, after.runs)
        ),
      label: "amount recall",
    },
    {
      build: (before, after) =>
        ratioDelta(
          meanRatio(before.amountF1Sum, before.runs),
          meanRatio(after.amountF1Sum, after.runs)
        ),
      label: "amount F1",
    },
    {
      build: (before, after) => {
        const beforeMatched = before.nameMatched;
        const afterMatched = after.nameMatched;
        return {
          after: `${after.nameExact}/${afterMatched}`,
          before: `${before.nameExact}/${beforeMatched}`,
          delta: signed(after.nameExact - before.nameExact, 0),
        };
      },
      label: "name exact",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.schemaValid, scored: before.runs },
          { exact: after.schemaValid, scored: after.runs }
        ),
      label: "schema valid",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.totalExact, scored: before.runs },
          { exact: after.totalExact, scored: after.runs }
        ),
      label: "total exact",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.paymentExact, scored: before.runs },
          { exact: after.paymentExact, scored: after.runs }
        ),
      label: "payment exact",
    },
    {
      build: (before, after) =>
        countDelta(
          { exact: before.reconcilePass, scored: before.runs },
          { exact: after.reconcilePass, scored: after.runs }
        ),
      label: "reconcile",
    },
    {
      build: (before, after) => countDelta(before.datetime, after.datetime),
      label: "datetime exact",
    },
    {
      build: (before, after) => countDelta(before.date, after.date),
      label: "date exact",
    },
    ...RESCORE_FIELDS.map((field) => ({
      build: (before: MetricNumbers, after: MetricNumbers) =>
        countDelta(before.fields[field], after.fields[field]),
      label: field,
    })),
    {
      build: (before, after) =>
        countDelta(
          { exact: before.gstReported, scored: before.runs },
          { exact: after.gstReported, scored: after.runs }
        ),
      label: "gst reported",
    },
  ];

  return definitions.map((definition) => [
    definition.label,
    ...columns.map((column) =>
      cell(
        definition.build(
          metricsOf(baseline, column),
          metricsOf(current, column)
        )
      )
    ),
  ]);
};

const deltaDisputes = (
  report: DisputesFile,
  summary: RescoreSummary
): string => {
  const labels = new Map(summary.receipts.map((r) => [r.id, r.label]));
  const rows: string[][] = [];
  for (const receipt of report.receipts) {
    const disputed = Object.entries(receipt.fields).filter(
      ([, field]) => field.disputed
    );
    if (disputed.length === 0) {
      continue;
    }
    rows.push([
      labels.get(receipt.receiptId) ?? receipt.receiptId,
      disputed
        .map(([field, value]) => {
          const observed = value.observed
            .map(
              (entry) =>
                `${show(entry.value)}${entry.count > 1 ? ` ×${entry.count}` : ""}`
            )
            .join(", ");
          return `${field}: key ${show(value.golden)} vs ${observed}`;
        })
        .join("; "),
    ]);
  }
  return rows.length === 0
    ? "Every model value matched the key."
    : markdownTable(["receipt", "fields still disputed"], rows);
};

const deltaLosses = (summary: RescoreSummary): string => {
  const blocks: string[] = [];
  let clean = 0;
  for (const receipt of summary.receipts) {
    for (const variant of extractionVariants) {
      const entry = receipt.variants[variant];
      if (!entry) {
        continue;
      }
      const lost = entry.runs.filter(
        (run) =>
          run.failed ||
          run.unmatchedGolden.length > 0 ||
          run.unmatchedPredicted.length > 0
      );
      if (lost.length === 0) {
        clean += 1;
        continue;
      }
      const lines = lost.map((run) => {
        const missed = run.unmatchedGolden.map(describeLine);
        const spare = run.unmatchedPredicted.map(describeLine);
        const parts: string[] = [];
        if (run.failed) {
          parts.push("the run failed");
        }
        if (missed.length > 0) {
          parts.push(
            `missed ${missed.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        if (spare.length > 0) {
          parts.push(
            `left over ${spare.map((line) => `\`${line}\``).join(", ")}`
          );
        }
        return `  - run ${run.run}: ${parts.join("; ")}`;
      });
      const mean =
        entry.metrics.runs === 0
          ? "—"
          : (entry.metrics.f1Sum / entry.metrics.runs).toFixed(3);
      blocks.push(
        [
          `**${receipt.label} · ${variant}** — mean F1 ${mean}, amount F1 ${
            entry.metrics.runs === 0
              ? "—"
              : (entry.metrics.amountF1Sum / entry.metrics.runs).toFixed(3)
          }`,
          ...lines,
        ].join("\n")
      );
    }
  }
  const note =
    clean === 0
      ? ""
      : `Every golden line matched in every run for the other ${clean} receipt × variant pairs.\n\n`;
  return `${note}${blocks.join("\n\n")}`;
};

const deltaMoneyLosses = (summary: RescoreSummary): string => {
  const rows: string[][] = [];
  for (const receipt of summary.receipts) {
    for (const variant of extractionVariants) {
      const entry = receipt.variants[variant];
      if (!entry) {
        continue;
      }
      for (const run of entry.runs) {
        if (run.amountUnmatchedGolden.length === 0) {
          continue;
        }
        rows.push([
          receipt.label,
          variant,
          `${run.run}`,
          run.amountUnmatchedGolden.map(describeLine).join(", "),
          run.amountUnmatchedPredicted.map(describeLine).join(", ") || "—",
        ]);
      }
    }
  }
  return rows.length === 0
    ? "No run missed a golden amount against the corrected key."
    : markdownTable(
        [
          "receipt",
          "variant",
          "run",
          "golden line missed",
          "predicted line left over",
        ],
        rows
      );
};

const receiptLabels = (summary: RescoreSummary, ids: string[]): string =>
  ids
    .map(
      (id) => summary.receipts.find((receipt) => receipt.id === id)?.label ?? id
    )
    .join(", ");

const deltaNotes = (
  baseline: RescoreSummary,
  current: RescoreSummary
): string[] => {
  const notes: string[] = [];

  if (
    baseline.receipts.every((receipt) => receipt.key.merchantAbn === null) &&
    current.receipts.some((receipt) => receipt.key.merchantAbn !== null)
  ) {
    notes.push(
      "The baseline key holds no ABN on any receipt, so its `merchantAbn` numerator only counted runs that also returned nothing — a null-vs-null match was never evidence of accuracy. The corrected key has the printed ABN, which is why that row falls: the metric starts measuring something."
    );
  }
  if (baseline.key.gst.length === 0 && current.key.gst.length > 0) {
    notes.push(
      `The baseline key has no GST anywhere, so \`gst\` had nothing to score (0/0). The corrected key prints a GST on ${current.key.gst.length} receipts, and \`gst reported\` shows the models rarely return one at all, so the gap is recall, not a wrong amount.`
    );
  }
  if (current.key.dateOnly.length > 0) {
    notes.push(
      `${receiptLabels(current, current.key.dateOnly)} is date-only in the corrected key, so ${current.key.dateOnly.length === 1 ? "it is" : "they are"} counted in \`date exact\` and removed from the \`datetime exact\` denominator. The model answers with a midnight placeholder, which is why the receipt still appears in the disputes list even when the day is right.`
    );
  }

  return notes;
};

export const buildDeltaMarkdown = (
  baseline: RescoreSummary,
  current: RescoreSummary,
  disputes: DisputesFile
): string => {
  const perReceipt = current.receipts.map((receipt) => {
    const before = baseline.receipts.find((entry) => entry.id === receipt.id);
    return [
      receipt.label,
      receipt.merchant,
      ...extractionVariants.map((variant) => {
        const after = receipt.variants[variant];
        const previous = before?.variants[variant];
        const beforeF1 =
          previous && previous.metrics.runs > 0
            ? (previous.metrics.f1Sum / previous.metrics.runs).toFixed(3)
            : "—";
        const afterF1 =
          after && after.metrics.runs > 0
            ? (after.metrics.f1Sum / after.metrics.runs).toFixed(3)
            : "—";
        if (beforeF1 === "—" || afterF1 === "—") {
          return `${beforeF1} → ${afterF1}`;
        }
        return `${beforeF1} → ${afterF1} (${signed(Number(afterF1) - Number(beforeF1), 3)})`;
      }),
    ];
  });

  return [
    `# ${baseline.label} → ${current.label}: what the corrected key changes`,
    "",
    `The same ${current.overall.runs} recorded runs (${current.runs.model}, ${current.receipts.length} receipts × ${current.runs.runsPerReceipt} runs × 4 variants) scored against two keys. No model was called: \`${current.runs.path}\` was re-read and re-scored.`,
    "",
    `- baseline key: \`${baseline.goldenPath}\` (${baseline.label})`,
    `- corrected key: \`${current.goldenPath}\` (${current.label})`,
    "",
    "`mean F1` is the matrix metric (amount within a cent and name similarity ≥ 0.75); `amount` and `name exact` are the new metrics; `date exact` is the date-only column, so `datetime exact` has a smaller denominator once Nike leaves it, and `gst` is scored only on receipts whose golden value is non-null. Every count is `exact/scored`, and the parenthesised change is the count difference **or** the ratio difference.",
    "",
    "## What changed in the key",
    "",
    markdownTable(
      ["receipt", "changed fields", "line items", "transactionDatetime"],
      keyChanges(baseline, current)
    ),
    "",
    "## Metric deltas",
    "",
    markdownTable(
      ["metric", ...extractionVariants, "overall"],
      deltaRows(baseline, current)
    ),
    "",
    "`overall` pools all four variants into one row per metric, which is why its denominators are four times the per-variant ones.",
    ...(deltaNotes(baseline, current).length === 0
      ? []
      : [
          "",
          "What moves, and why:",
          "",
          ...deltaNotes(baseline, current).map((note) => `- ${note}`),
        ]),
    "",
    "## Per-receipt F1",
    "",
    markdownTable(["receipt", "merchant", ...extractionVariants], perReceipt),
    "",
    "Each cell is `before → after (change)` for the mean of the three runs.",
    "",
    "## What the corrected key still cannot match",
    "",
    "Per receipt and variant, the golden lines no predicted line matched in at least one run, beside the predicted lines left over. A name on the left that appears unpaired on the right is a formatting difference; an amount that appears on one side only is a missing or wrong line.",
    "",
    deltaLosses(current),
    "",
    "## Money-only losses against the corrected key",
    "",
    "Names ignored, `kind` and magnitude compared. A row here is a money error — a wrong amount, a missing line, a duplicated line, or a discount recorded as a product — not a spelling.",
    "",
    deltaMoneyLosses(current),
    "",
    "## Fields the corrected key still disputes",
    "",
    deltaDisputes(disputes, current),
    "",
    "The disputes list compares raw strings, so a date-only key that the model answers with a midnight placeholder reads as disputed there while `date exact` counts it correct. That is the point of splitting the two columns, and it is why the Nike row appears in the table above.",
    "",
  ].join("\n");
};
