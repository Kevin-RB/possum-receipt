import { generateText, Output } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";

import { CATEGORIZE_MODEL } from "./models";
import { extractionModel } from "./provider";

export interface CategoryOption {
  name: string;
  parentName: string | null;
  slug: string;
}

export interface CategorizeItem {
  kind: string;
  name: string;
}

export const CATEGORIZE_CHUNK_SIZE = 25;

const describeCategory = (option: CategoryOption): string =>
  option.parentName ? `${option.parentName}: ${option.name}` : option.name;

const buildResponseSchema = (slugs: string[]) =>
  z.object({
    items: z.array(
      z.object({
        category: z.enum(slugs as [string, ...string[]]),
        index: z.number().int().min(0),
      })
    ),
  });

const buildPrompt = (
  items: CategorizeItem[],
  options: CategoryOption[]
): string => {
  const categories = options
    .map((option) => `- ${option.slug}: ${describeCategory(option)}`)
    .join("\n");
  const lines = items
    .map((item, index) => `${index}. [${item.kind}] ${item.name}`)
    .join("\n");

  return `You are a receipt categorisation expert. Classify every line item below into exactly one category from the list.

## Categories

${categories}

## Line items

${lines}

Return one entry per line item, using its zero-based index from the list above and the chosen category's slug. Classify every item — do not skip any. Always choose the most specific matching category.`;
};

const chunkItems = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

export const categorizeItems = async (
  items: CategorizeItem[],
  options: CategoryOption[],
  model: LanguageModel = extractionModel(CATEGORIZE_MODEL, "categorize"),
  chunkSize = CATEGORIZE_CHUNK_SIZE
): Promise<(string | null)[]> => {
  if (items.length === 0) {
    return [];
  }
  if (options.length === 0) {
    throw new Error("Cannot categorize line items without any categories");
  }

  const schema = buildResponseSchema(options.map((option) => option.slug));
  const results: (string | null)[] = Array.from(
    { length: items.length },
    () => null
  );

  const chunks = chunkItems(items, chunkSize);
  await Promise.all(
    chunks.map(async (chunk, chunkIndex) => {
      const offset = chunkIndex * chunkSize;
      const { output } = await generateText({
        maxRetries: 1,
        model,
        output: Output.object({ schema }),
        prompt: buildPrompt(chunk, options),
        temperature: 0,
      });

      for (const entry of output.items) {
        if (entry.index < 0 || entry.index >= chunk.length) {
          continue;
        }
        results[offset + entry.index] = entry.category;
      }
    })
  );

  return results;
};
