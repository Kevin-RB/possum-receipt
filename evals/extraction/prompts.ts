import { z } from "zod/v4";

import { PARSE_PROMPT } from "@/lib/ai/transcribe-receipt-image";
import { ReceiptInformationExtractionSchema } from "@/lib/db/contract";

/**
 * Variant A is the production parse prompt reworded from the transcript framing
 * to the image framing, so the only thing that changes is where the text comes
 * from. The replacement is asserted: if the prompt is ever edited such that the
 * opening clause no longer matches, this throws instead of quietly running the
 * transcript prompt against an image.
 */
const TRANSCRIPT_CLAUSE = "Given the raw OCR transcription of a receipt";
const IMAGE_CLAUSE = "Given this receipt image";

export const IMAGE_PARSE_PROMPT = PARSE_PROMPT.replace(
  TRANSCRIPT_CLAUSE,
  IMAGE_CLAUSE
);

if (IMAGE_PARSE_PROMPT === PARSE_PROMPT) {
  throw new Error(
    `PARSE_PROMPT no longer contains "${TRANSCRIPT_CLAUSE}", so the image framing could not be applied.`
  );
}

/**
 * Variant A's model-facing schema: the production contract plus a `transcript`
 * field declared first, so the model transcribes the receipt verbatim before it
 * extracts anything. `transcript` is stripped before scoring; the stored
 * receipt fields are exactly the contract's.
 */
export const TranscriptExtractionSchema = z.object({
  transcript: z
    .string()
    .describe(
      "The receipt's full text transcribed verbatim from the image, preserving line breaks, before any field extraction."
    ),
  ...ReceiptInformationExtractionSchema.shape,
});

export type TranscriptExtraction = z.infer<typeof TranscriptExtractionSchema>;
