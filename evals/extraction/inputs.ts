import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { CategoryOption } from "@/lib/ai/categorize";

import type {
  CategorizationGoldenItem,
  CorpusEntry,
  GoldenReceipt,
} from "./types";

export const IMAGE_MEDIA_TYPE = "image/jpeg";

const corpusEntrySchema = z.object({
  bytes: z.number(),
  height: z.number(),
  id: z.string().min(1),
  imagePath: z.string().min(1),
  merchant: z.string(),
  objectKey: z.string(),
  sha256: z.string().length(64),
  total: z.number(),
  transactionDatetime: z.string().nullable(),
  width: z.number(),
});

const goldenItemSchema = z.object({
  kind: z.string(),
  lineTotal: z.number(),
  name: z.string(),
  quantity: z.number().nullable(),
  unitPrice: z.number().nullable(),
});

export const goldenReceiptSchema = z.object({
  gst: z.number().nullable(),
  hasIntegrityWarning: z.boolean(),
  id: z.string().min(1),
  items: z.array(goldenItemSchema),
  merchantAbn: z.string().nullable(),
  merchantAddress: z.string().nullable(),
  merchantName: z.string(),
  merchantStoreId: z.string().nullable(),
  paymentMethod: z.string(),
  receiptNumber: z.string().nullable(),
  subtotal: z.number().nullable(),
  total: z.number(),
  transactionDatetime: z.string().nullable(),
});

const categoryOptionSchema = z.object({
  name: z.string().min(1),
  parentName: z.string().nullable(),
  slug: z.string().min(1),
});

const categorizationGoldenItemSchema = z.object({
  categorySlug: z.string().min(1),
  kind: z.string(),
  name: z.string(),
});

const readJson = async (file: string): Promise<unknown> => {
  const text = await readFile(file, "utf-8");
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(
      `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
};

const parseOrThrow = <T>(
  schema: z.ZodType<T>,
  value: unknown,
  file: string
): T => {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${file} does not match the expected shape:\n${z.prettifyError(result.error)}`
    );
  }
  return result.data;
};

export interface ReceiptImage {
  base64: string;
  mediaType: string;
}

export interface EvalInputs {
  categories: CategoryOption[];
  categorizationGolden: CategorizationGoldenItem[];
  corpus: CorpusEntry[];
  golden: Map<string, GoldenReceipt>;
  images: Map<string, ReceiptImage>;
}

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/**
 * Loads the read-only inputs and refuses anything inconsistent: a corpus row
 * without a golden row, a taxonomy without its golden labels, or an image whose
 * bytes or digest do not match `corpus.json`. The images are real owner
 * receipts, so a wrong file must stop the run before it is sent anywhere.
 */
export const loadEvalInputs = async (
  corpusDir: string
): Promise<EvalInputs> => {
  const corpusFile = path.join(corpusDir, "corpus.json");
  const goldenFile = path.join(corpusDir, "golden.draft.json");
  const categoriesFile = path.join(corpusDir, "categories.json");
  const categorizationFile = path.join(corpusDir, "categorization.golden.json");

  const corpus = parseOrThrow(
    z.array(corpusEntrySchema).min(1),
    await readJson(corpusFile),
    corpusFile
  );
  const goldenRows = parseOrThrow(
    z.array(goldenReceiptSchema).min(1),
    await readJson(goldenFile),
    goldenFile
  );
  const categories = parseOrThrow(
    z.array(categoryOptionSchema),
    await readJson(categoriesFile),
    categoriesFile
  );
  const categorizationGolden = parseOrThrow(
    z.array(categorizationGoldenItemSchema),
    await readJson(categorizationFile),
    categorizationFile
  );

  if (categories.length !== 44) {
    throw new Error(
      `categories.json holds ${categories.length} categories, expected the seeded 44.`
    );
  }
  if (categorizationGolden.length !== 46) {
    throw new Error(
      `categorization.golden.json holds ${categorizationGolden.length} items, expected the 46 user-labelled rows.`
    );
  }

  const slugs = new Set(categories.map((category) => category.slug));
  for (const item of categorizationGolden) {
    if (!slugs.has(item.categorySlug)) {
      throw new Error(
        `categorization.golden.json names unknown slug "${item.categorySlug}" (${item.name}).`
      );
    }
  }

  const golden = new Map<string, GoldenReceipt>();
  for (const row of goldenRows) {
    golden.set(row.id, row);
  }
  for (const entry of corpus) {
    if (!golden.has(entry.id)) {
      throw new Error(
        `corpus.json has ${entry.id} but golden.draft.json does not.`
      );
    }
  }
  if (golden.size !== corpus.length) {
    throw new Error(
      `golden.draft.json has ${golden.size} receipts, corpus.json has ${corpus.length}.`
    );
  }

  const loaded = await Promise.all(
    corpus.map(async (entry): Promise<[string, ReceiptImage]> => {
      const bytes = await readFile(path.join(corpusDir, entry.imagePath));
      if (bytes.byteLength !== entry.bytes) {
        throw new Error(
          `${entry.imagePath} is ${bytes.byteLength} bytes, corpus.json says ${entry.bytes}.`
        );
      }
      const digest = sha256(bytes);
      if (digest !== entry.sha256) {
        throw new Error(
          `${entry.imagePath} has sha256 ${digest}, corpus.json says ${entry.sha256}.`
        );
      }
      return [
        entry.id,
        { base64: bytes.toString("base64"), mediaType: IMAGE_MEDIA_TYPE },
      ];
    })
  );
  const images = new Map(loaded);

  return {
    categories,
    categorizationGolden,
    corpus,
    golden,
    images,
  };
};
