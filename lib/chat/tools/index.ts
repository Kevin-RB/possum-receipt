import type {
  InferUITools,
  ToolSet,
  ToolUIPart,
  UIDataTypes,
  UIMessage,
} from "ai";

import { ask_user } from "./ask-user";
import { list_receipts } from "./list-receipts";
import { receipt_detail } from "./receipt-detail";
import { search_line_items } from "./search-line-items";
import { spend_by_category } from "./spend-by-category";
import { spend_by_merchant } from "./spend-by-merchant";

/**
 * Every read tool is bound to `ownerId` here, so a tool call can never reach
 * another user's receipts: the owner is closed over server-side and the model
 * never sees or supplies it.
 *
 * `today` is closed over the same way, and is the caller's: the route resolves
 * it once from the viewer's clock and passes the same value to the prompt, so a
 * named period the model picks resolves against the day it was told is today
 * rather than a second reading of the clock.
 *
 * Keys are the model-facing tool names, which must match the `tool-<name>`
 * part discriminants the UI switches on in `components/chat/chat-message.tsx`.
 */
export const buildChatTools = (ownerId: string, today: Temporal.PlainDate) =>
  ({
    ask_user,
    list_receipts: list_receipts(ownerId, today),
    receipt_detail: receipt_detail(ownerId),
    search_line_items: search_line_items(ownerId, today),
    spend_by_category: spend_by_category(ownerId, today),
    spend_by_merchant: spend_by_merchant(ownerId, today),
  }) satisfies ToolSet;

export type ChatTools = ReturnType<typeof buildChatTools>;

export type ChatUIMessage = UIMessage<
  never,
  UIDataTypes,
  InferUITools<ChatTools>
>;

export type ChatMessagePart = ChatUIMessage["parts"][number];

/**
 * Each alias below picks the tool out of `ChatTools` by key, so the name is
 * written once and TypeScript checks it against the tool set. The earlier
 * `Extract<ChatMessagePart, { type: "tool-spend_by_..." }>` spelling resolved a
 * typo to `never` and only failed later, at the use site, with
 * "Property 'state' does not exist on type 'never'".
 *
 * `chat-message.tsx` narrows the union with a `switch` on `part.type` rather
 * than importing these, so the switch cases are checked against the same
 * source; the aliases are what each renderer declares its parameter as.
 */
export type AskUserToolPart = ToolUIPart<
  InferUITools<Pick<ChatTools, "ask_user">>
>;
export type ListReceiptsToolPart = ToolUIPart<
  InferUITools<Pick<ChatTools, "list_receipts">>
>;
export type ReceiptDetailToolPart = ToolUIPart<
  InferUITools<Pick<ChatTools, "receipt_detail">>
>;
export type SearchLineItemsToolPart = ToolUIPart<
  InferUITools<Pick<ChatTools, "search_line_items">>
>;
export type SpendByCategoryToolPart = ToolUIPart<
  InferUITools<Pick<ChatTools, "spend_by_category">>
>;
export type SpendByMerchantToolPart = ToolUIPart<
  InferUITools<Pick<ChatTools, "spend_by_merchant">>
>;

/** The questionnaire's answer shape, straight off the tool's `outputSchema`. */
export type AskUserAnswers = NonNullable<AskUserToolPart["output"]>;
