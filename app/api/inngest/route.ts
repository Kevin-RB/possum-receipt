import { serve } from "inngest/next";

import { inngest } from "@/lib/inngest/client";
import { categorizeReceipt } from "@/lib/inngest/functions/categorize-receipt";
import { transcribeReceipt } from "@/lib/inngest/functions/transcribe-receipt";

/**
 * Vercel caps a function at 300s on Hobby, which is the same as the default —
 * naming it keeps the extraction and categorization steps from being cut short
 * if the platform's default ever moves, and Inngest reads it when deciding how
 * long a step may run.
 */
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [transcribeReceipt, categorizeReceipt],
});
