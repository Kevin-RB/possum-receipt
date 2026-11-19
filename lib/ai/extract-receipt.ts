import { generateText, NoObjectGeneratedError, Output } from "ai";
import { z } from "zod";

import type { ReceiptInformationExtraction } from "@/lib/db/contract";
import { ReceiptInformationExtractionSchema } from "@/lib/db/contract";

import { EXTRACT_MODEL } from "./models";
import { extractionModel } from "./provider";

export const EXTRACTION_PROMPT = `You are a receipt data extraction expert. Given this receipt image, transcribe it and extract structured receipt data from it.

## Reading the receipt

- **transcript**: transcribe every printed line of the receipt verbatim, in the order it is printed, preserving line breaks and the amounts as printed. Write it before you extract any other field. It is the record of what the paper actually said, and a person uses it to check the fields below against the image, so never summarise, translate, reorder or drop lines.

## Field mapping rules

- **merchant.name**: The store or business name, typically at the top of the receipt.
- **merchant.abn**: Australian Business Number if present (11-digit number, may be formatted as XX XXX XXX XXX).
- **merchant.address**: Store address, typically near the top.
- **merchant.storeId**: Store/branch identifier if present.
- **transaction.datetime**: Transaction date and time as a bare ISO 8601 string representing the local wall-clock time printed on the receipt (e.g. "2026-07-28T18:51:00"). Do NOT include a timezone suffix ("Z", "+10:00", etc.). Use the time printed for the transaction, not a settlement or approval time from the payment block.
- **transaction.receiptNumber**: Receipt/invoice/transaction number if present.
- **items**: Array of line items. Each item must have a **name** (string), a **lineTotal** (number, in dollars), and a **kind**:
  - **"product"** for a normal product or service line.
  - **"surcharge"** for a fee the merchant adds for the payment method (for example a "CREDIT SURCHARGE" or card fee, often a percentage of the total). A surcharge is its own line; never fold it into another item or omit it.
  - **"discount"** for a deduction. Its **lineTotal** must be negative, and so must its **unitPrice** — a discount removes from the total, so report the deduction as a negative amount rather than as a positive one to be subtracted later. A negative **lineTotal** is read as a discount whichever kind you label it, so label it "discount".
  Each item may also have **quantity** (number) and **unitPrice** (number):
  - **quantity**: the number of units stated on the receipt. If the receipt prints no quantity for a line, use **1**. Never leave it out and never invent a quantity.
  - **unitPrice**: only when the receipt prints a unit price. Never compute it from lineTotal ÷ quantity; omit it when the receipt does not print it. For a discount, report it negative to match the line total.
- **totals.total**: The final total amount paid (number, in dollars). Always required.
- **totals.subtotal**: The subtotal **exactly as printed** on the receipt, GST-inclusive (number, in dollars). Only include it when the receipt prints a subtotal line. Never compute or back-solve a subtotal (for example, never calculate total − GST).
- **totals.gst**: The GST amount **exactly as printed**, representing tax already included within the total (number, in dollars). Only include it when the receipt states a GST amount. GST is a component of the total, never an amount added on top of it.
- **payment.method**: Always present. Payment method, normalized to one of "cash", "card", or "other":
  - Card-like methods (e.g. VISA, Mastercard, EFTPOS, debit, credit) → "card"
  - Cash → "cash"
  - Anything unrecognized → "other"
  If no payment method appears on the receipt at all, return "other".

## Sub-line collapse rules

Some receipts have multi-line entries where an item name spans multiple printed lines, and modifiers (size, colour, options) appear on separate lines below the item name. These modifiers should be folded into the **name** field of a single item, not treated as separate items.

Example:
  "REG LATTE"
  "SRIRACHA CHICKEN"
  "DINE IN"
  "LARGE"
Should become:
  { name: "REG LATTE SRIRACHA CHICKEN LARGE (DINE IN)", lineTotal: ... }

Rules for folding:
- Lines that are only a size/colour/modifier or dine-in/takeaway flag that follow an item line should be appended to the preceding item name.
- Lines that contain a dollar amount on the same line are always separate items.
- A unit-price or weight breakdown printed under a line (for example "2 @ $3.70 EACH" or "1.091 kg NET @ $4.50/kg") is part of that line, not an item of its own.

## Amount extraction

- All amounts are in dollars (e.g. "$12.50" → 12.50).
- Remove currency symbols, parse as numbers.
- Negative amounts are discounts: keep the negative value in **lineTotal** and set **kind** to "discount".
- A printed discount is a negative amount whichever way the receipt prints it: report **lineTotal** (and **unitPrice**, if printed) as negative for kind "discount", never as a positive amount that stands for a reduction.

## Fallback rules

- If the receipt does not print a subtotal, omit the subtotal entirely. Never derive it.
- If the receipt does not state GST, omit it.
- If a line prints no quantity, use 1.
- Omit unitPrice unless the receipt prints it.
- If the merchant name cannot be found, use "Unknown Merchant".
- If the transaction datetime cannot be parsed to ISO 8601, omit it.

Return valid JSON conforming to the schema. Use appropriate types (strings for text, numbers for amounts).`;

/**
 * The contract plus the transcript, for the model only.
 *
 * `transcript` leads so the model writes what it read before it writes any
 * field, and it is stripped before the receipt is stored: no column changes,
 * and `receiptToFlat` never sees it.
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

/**
 * How much of a malformed response is kept.
 *
 * A schema failure keeps the text the model returned, because that is the only
 * record of what it read once reading and structuring are one call (ADR-0008).
 * The cap exists because the failure is by definition a response the app did
 * not expect, and a model that loops should not be able to write megabytes into
 * a receipt row.
 */
export const FAILED_TRANSCRIPT_LIMIT = 20_000;

/**
 * The call's outcome, returned rather than thrown.
 *
 * A response that does not satisfy the schema is an expected failure: it is
 * stored as the receipt's error and leaves its raw text behind, so the caller
 * needs both facts and neither is an exception. Provider failures still throw —
 * they are the run's business, not the caller's, and Inngest's retry policy has
 * to see them.
 */
export type ExtractionAttempt =
  | {
      extraction: ReceiptInformationExtraction;
      ok: true;
      transcript: string;
    }
  | { ok: false; rawText: string | null; reason: string };

export const extractReceipt = async ({
  base64,
  mediaType,
  model = EXTRACT_MODEL,
}: {
  base64: string;
  mediaType: string;
  model?: string;
}): Promise<ExtractionAttempt> => {
  try {
    const result = await generateText({
      maxRetries: 1,
      messages: [
        {
          content: [
            { text: EXTRACTION_PROMPT, type: "text" },
            { data: base64, mediaType, type: "file" },
          ],
          role: "user",
        },
      ],
      model: extractionModel(model, "extraction"),
      output: Output.object({ schema: TranscriptExtractionSchema }),
      temperature: 0,
    });

    const { transcript, ...extraction } = result.output;

    return { extraction, ok: true, transcript };
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error)) {
      throw error;
    }

    const rawText = error.text?.trim();

    return {
      ok: false,
      rawText: rawText ? rawText.slice(0, FAILED_TRANSCRIPT_LIMIT) : null,
      reason: error.message,
    };
  }
};
