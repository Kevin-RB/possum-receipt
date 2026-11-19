import { z } from "zod";

/**
 * The extraction models the app offers.
 *
 * A dated revision is deliberate: the undated `deepseek/deepseek-v4.1-flash`
 * alias resolves to an older, unpinned snapshot, which is drift rather than a
 * saving. This is the same id chat runs on (ADR-0017), so one credential, one
 * model and one data-policy track cover every call the app makes.
 */
export const EXTRACTION_MODELS = ["deepseek/deepseek-v4.1-flash-1017"] as const;

/** The model a first extraction runs on, unless the environment names another. */
export const EXTRACT_MODEL = process.env.EXTRACT_MODEL ?? EXTRACTION_MODELS[0];

/** Categorization runs on the extraction model unless it is given its own. */
export const CATEGORIZE_MODEL = process.env.CATEGORIZE_MODEL ?? EXTRACT_MODEL;

/**
 * What the re-process picker offers, and what the trigger accepts: the
 * configured default plus the catalogue, without duplicates.
 *
 * The configured model is first because it is the one a first extraction uses,
 * so re-running a receipt as it was extracted is the default choice. It is
 * included even when it is not in the catalogue, so a deployment that sets
 * `EXTRACT_MODEL` can pick that model again rather than having its own default
 * refused.
 */
export const extractionSelections = (): string[] => [
  ...new Set([EXTRACT_MODEL, ...EXTRACTION_MODELS].filter(Boolean)),
];

/**
 * A re-process names one model. It travels with the event rather than being
 * read from the environment at run time, so a receipt that extracted badly can
 * be retried with a different one without a redeploy.
 *
 * Ids are bounded rather than free text: the trigger checks one against
 * `extractionSelections()` before a run is started.
 */
export const extractionModelIdSchema = z.string().min(1).max(200);
