"use client";

import { Gather } from "loading-dev";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  LoaderCircleIcon,
  TriangleAlertIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import type {
  CategoryTotal,
  LineItemMatch,
  MerchantTotal,
  ReceiptDetail,
  ReceiptSummary,
} from "@/lib/chat/output-schemas";
import type { ChatMessagePart } from "@/lib/chat/tools";

import { formatAmount, formatDay } from "./format";
import { ResultTable } from "./parts/result-table";

type ToolPart = Extract<ChatMessagePart, { type: `tool-${string}` }>;
type ToolState = ToolPart["state"];
type StepStatus = "running" | "error";

interface StepProps<T extends ToolPart["type"]> {
  part: Extract<ToolPart, { type: T }>;
  streaming: boolean;
}

const plural = (count: number, singular: string, pluralForm: string) =>
  `${count} ${count === 1 ? singular : pluralForm}`;

/**
 * Map an AI SDK tool state to a trace status. A tool that is still
 * `input-available` after the chat stopped never produced output, so it
 * reads as failed rather than forever running. The exception is a
 * client-side tool such as `ask_user`: it stays `input-available` while it
 * waits for the person, so it keeps running.
 */
const stepStatus = (
  state: ToolState,
  streaming: boolean,
  clientSide = false
): StepStatus | undefined => {
  if (state === "output-available") {
    return undefined;
  }

  if (state === "output-error") {
    return "error";
  }

  return streaming || clientSide ? "running" : "error";
};

/** Pick the title that matches the step's status. */
const verb = (
  status: StepStatus | undefined,
  running: string,
  done: string,
  failed: string
) => {
  if (status === "running") {
    return running;
  }

  if (status === "error") {
    return failed;
  }

  return done;
};

const StatusIcon = ({ status }: { status?: StepStatus }) => {
  if (status === "running") {
    return <LoaderCircleIcon className="animate-spin" />;
  }

  if (status === "error") {
    return <CircleAlertIcon />;
  }

  return <CircleCheckIcon />;
};

const ErrorDetail = ({ text }: { text: string }) => (
  <p className="text-destructive text-xs">{text}</p>
);

/**
 * One trace line. A step with output becomes a `TraceCollapsible`: the line
 * sits in the trigger and the detail (a table, a list, an error) sits in the
 * content, below and indented. A step with nothing to show stays a plain line.
 */
const Step = ({
  children,
  defaultOpen,
  description,
  status,
  title,
}: {
  children?: ReactNode;
  defaultOpen?: boolean;
  description?: ReactNode;
  status?: StepStatus;
  title: string;
}) => {
  const line = (
    // No `aria-live`: the chat owns one polite status region for the whole
    // transcript, so a step that changes state is not announced twice, once per
    // row.
    <TraceLine status={status}>
      <TraceIcon>
        <StatusIcon status={status} />
      </TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {description ? <TraceDescription>{description}</TraceDescription> : null}
    </TraceLine>
  );

  if (!children) {
    return line;
  }

  return (
    <TraceCollapsible defaultOpen={defaultOpen}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>{children}</TraceCollapsibleContent>
    </TraceCollapsible>
  );
};

const useTimer = (running: boolean) => {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    if (!running) {
      return;
    }

    const interval = window.setInterval(() => {
      setSeconds((s) => s + 1);
    }, 1000);

    return () => window.clearInterval(interval);
  }, [running]);

  return seconds;
};

export const AskUserStep = ({
  part,
  streaming,
}: StepProps<"tool-ask_user">) => {
  const status = stepStatus(part.state, streaming, true);
  const count = part.state === "output-available" ? part.output.length : 0;
  const error =
    part.state === "output-error" ? (
      <ErrorDetail text={part.errorText} />
    ) : null;

  return (
    <Step
      defaultOpen
      status={status}
      title={verb(
        status,
        "Asking you a question",
        `Answered ${plural(count, "question", "questions")}`,
        "Failed to ask a question"
      )}
    >
      {error ||
        (part.state === "output-available" ? (
          <ol className="flex flex-col gap-1 text-xs">
            {part.output.map((entry) => (
              <li key={entry.question}>
                <span className="text-muted-foreground">{entry.question}</span>{" "}
                <span className="font-medium">{entry.answer}</span>
              </li>
            ))}
          </ol>
        ) : null)}
    </Step>
  );
};

const ListReceiptsStep = ({
  part,
  streaming,
}: StepProps<"tool-list_receipts">) => {
  const status = stepStatus(part.state, streaming);
  const count = part.state === "output-available" ? part.output.length : 0;
  const done =
    count === 0
      ? "Found no receipts"
      : `Found ${plural(count, "receipt", "receipts")}`;
  const error =
    part.state === "output-error" ? (
      <ErrorDetail text={part.errorText} />
    ) : null;

  return (
    <Step
      defaultOpen
      status={status}
      title={verb(status, "Listing receipts", done, "Failed to list receipts")}
    >
      {error ||
        (part.state === "output-available" ? (
          <ResultTable
            caption="Receipts"
            columns={[
              {
                header: "Merchant",
                render: (row: ReceiptSummary) => (
                  <Link
                    className="hover:text-foreground"
                    href={`/receipts/${row.id}`}
                  >
                    {row.merchant ?? "Unknown"}
                  </Link>
                ),
              },
              {
                header: "Date",
                render: (row: ReceiptSummary) => formatDay(row.date),
              },
              {
                align: "end",
                header: "Total",
                render: (row: ReceiptSummary) => formatAmount(row.total),
              },
              {
                align: "end",
                header: "",
                render: (row: ReceiptSummary) =>
                  row.hasIntegrityWarning ? (
                    <TriangleAlertIcon
                      aria-label="Failed total check"
                      className="text-destructive size-3.5"
                    />
                  ) : null,
              },
            ]}
            empty="No receipts matched that filter."
            rows={part.output}
            rowKey={(row) => row.id}
          />
        ) : null)}
    </Step>
  );
};

const ReceiptDetailStep = ({
  part,
  streaming,
}: StepProps<"tool-receipt_detail">) => {
  const status = stepStatus(part.state, streaming);
  const receipt = part.state === "output-available" ? part.output : null;
  const error =
    part.state === "output-error" ? (
      <ErrorDetail text={part.errorText} />
    ) : null;

  let done = "Read the receipt";
  if (part.state === "output-available") {
    if (!part.output) {
      done = "Receipt not found";
    } else if (part.output.merchant) {
      done = `Read the ${part.output.merchant} receipt`;
    }
  }

  type DetailItem = ReceiptDetail["items"][number];

  return (
    <Step
      defaultOpen
      description={receipt ? formatDay(receipt.date) : null}
      status={status}
      title={verb(status, "Reading receipt", done, "Failed to read receipt")}
    >
      {error ||
        (receipt ? (
          <>
            <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>{formatAmount(receipt.total)}</span>
              {receipt.paymentMethod ? (
                <span>{receipt.paymentMethod}</span>
              ) : null}
              <Link
                className="hover:text-foreground inline-flex items-center gap-1"
                href={`/receipts/${receipt.id}`}
              >
                Open receipt
              </Link>
            </div>
            <ResultTable
              caption="Line items"
              columns={[
                {
                  header: "Item",
                  render: (row: DetailItem) => (
                    <span className="flex items-baseline gap-1.5">
                      {row.name}
                      {row.kind === "product" ? null : (
                        <span className="text-muted-foreground text-xs uppercase">
                          {row.kind}
                        </span>
                      )}
                    </span>
                  ),
                },
                {
                  align: "end",
                  header: "Qty",
                  render: (row: DetailItem) =>
                    row.quantity === null ? "—" : row.quantity,
                },
                {
                  align: "end",
                  header: "Total",
                  render: (row: DetailItem) => formatAmount(row.lineTotal),
                },
              ]}
              empty="No line items were captured for this receipt."
              rows={receipt.items}
              rowKey={(row, index) => `${index}-${row.name}`}
            />
          </>
        ) : null)}
    </Step>
  );
};

const largestTotal = (rows: CategoryTotal[]): number => {
  let largest = 0;
  for (const row of rows) {
    if (row.total > largest) {
      largest = row.total;
    }
  }
  return largest;
};

const SearchLineItemsStep = ({
  part,
  streaming,
}: StepProps<"tool-search_line_items">) => {
  const status = stepStatus(part.state, streaming);
  const output = part.state === "output-available" ? part.output : null;
  const query = part.input?.query;
  const found =
    output && output.count > 0
      ? `Found ${plural(output.count, "match", "matches")}`
      : "Found no matches";
  const error =
    part.state === "output-error" ? (
      <ErrorDetail text={part.errorText} />
    ) : null;

  return (
    <Step
      defaultOpen
      status={status}
      title={verb(
        status,
        "Searching items",
        `${found}${query ? ` for “${query}”` : ""}`,
        "Failed to search items"
      )}
    >
      {error ||
        (output ? (
          <>
            {output.count > 0 ? (
              <p className="text-muted-foreground text-xs">
                {formatAmount(output.total)} across products
              </p>
            ) : null}
            <ResultTable
              caption="Matching items"
              columns={[
                {
                  header: "Item",
                  render: (row: LineItemMatch) => (
                    <span className="flex flex-col">
                      {row.item}
                      {row.category ? (
                        <span className="text-muted-foreground text-xs">
                          {row.category}
                        </span>
                      ) : null}
                    </span>
                  ),
                },
                {
                  header: "Merchant",
                  render: (row: LineItemMatch) => (
                    <Link
                      className="hover:text-foreground"
                      href={`/receipts/${row.receiptId}`}
                    >
                      {row.merchant ?? "Unknown"}
                    </Link>
                  ),
                },
                {
                  header: "Date",
                  render: (row: LineItemMatch) => formatDay(row.date),
                },
                {
                  align: "end",
                  header: "Total",
                  render: (row: LineItemMatch) => formatAmount(row.lineTotal),
                },
              ]}
              empty="Nothing matched that search."
              rows={output.items}
              rowKey={(row, index) => `${row.receiptId}-${index}-${row.item}`}
            />
          </>
        ) : null)}
    </Step>
  );
};

const SpendByCategoryStep = ({
  part,
  streaming,
}: StepProps<"tool-spend_by_category">) => {
  const status = stepStatus(part.state, streaming);
  const output = part.state === "output-available" ? part.output : null;
  const scope = part.input?.category;
  const grouping =
    part.input?.groupBy === "category" ? "category" : "subcategory";
  const subject = scope ? `${scope} spend` : `spend by ${grouping}`;
  const largest = output ? largestTotal(output.categories) : 0;
  const error =
    part.state === "output-error" ? (
      <ErrorDetail text={part.errorText} />
    ) : null;

  return (
    <Step
      defaultOpen
      description={output ? formatAmount(output.total) : null}
      status={status}
      title={verb(
        status,
        `Totalling ${subject}`,
        `Totalled ${subject}`,
        "Failed to total spend by category"
      )}
    >
      {error ||
        (output ? (
          <ResultTable
            caption={
              scope
                ? `Spend by ${grouping} in ${scope}`
                : `Spend by ${grouping}`
            }
            columns={[
              {
                header: "Category",
                render: (row: CategoryTotal) => (
                  <span className="flex flex-col gap-1">
                    {row.category}
                    {largest > 0 ? (
                      <span
                        aria-hidden="true"
                        className="bg-muted h-0.5 w-full overflow-hidden rounded-full"
                        style={
                          {
                            "--share": row.total / largest,
                          } as React.CSSProperties
                        }
                      >
                        <span className="share-bar bg-primary/40 block h-full w-full origin-left" />
                      </span>
                    ) : null}
                  </span>
                ),
              },
              {
                align: "end",
                header: "Total",
                render: (row: CategoryTotal) => formatAmount(row.total),
              },
            ]}
            empty="No categorised spend in that period."
            rows={output.categories}
            rowKey={(row) => row.category}
          />
        ) : null)}
    </Step>
  );
};

const SpendByMerchantStep = ({
  part,
  streaming,
}: StepProps<"tool-spend_by_merchant">) => {
  const status = stepStatus(part.state, streaming);
  const output = part.state === "output-available" ? part.output : null;
  const error =
    part.state === "output-error" ? (
      <ErrorDetail text={part.errorText} />
    ) : null;

  return (
    <Step
      defaultOpen
      description={output ? formatAmount(output.total) : null}
      status={status}
      title={verb(
        status,
        "Totalling spend by merchant",
        "Totalled spend by merchant",
        "Failed to total spend by merchant"
      )}
    >
      {error ||
        (output ? (
          <ResultTable
            caption="Spend by merchant"
            columns={[
              {
                header: "Merchant",
                render: (row: MerchantTotal) => row.merchant,
              },
              {
                align: "end",
                header: "Receipts",
                render: (row: MerchantTotal) => row.receipts,
              },
              {
                align: "end",
                header: "Total",
                render: (row: MerchantTotal) => formatAmount(row.total),
              },
            ]}
            empty="No receipts in that period."
            rows={output.merchants}
            rowKey={(row) => row.merchant}
          />
        ) : null)}
    </Step>
  );
};

const unreachableToolPart = (part: never): never => {
  throw new Error(`Unhandled tool part: ${JSON.stringify(part)}`);
};

const StepRow = ({
  part,
  streaming,
}: {
  part: ToolPart;
  streaming: boolean;
}) => {
  switch (part.type) {
    case "tool-ask_user": {
      return <AskUserStep part={part} streaming={streaming} />;
    }
    case "tool-list_receipts": {
      return <ListReceiptsStep part={part} streaming={streaming} />;
    }
    case "tool-receipt_detail": {
      return <ReceiptDetailStep part={part} streaming={streaming} />;
    }
    case "tool-search_line_items": {
      return <SearchLineItemsStep part={part} streaming={streaming} />;
    }
    case "tool-spend_by_category": {
      return <SpendByCategoryStep part={part} streaming={streaming} />;
    }
    case "tool-spend_by_merchant": {
      return <SpendByMerchantStep part={part} streaming={streaming} />;
    }
    default: {
      return unreachableToolPart(part);
    }
  }
};

const ChainOfThought = ({
  hasActiveReasoning,
  isStreaming,
  onOpenChange,
  open,
  seconds,
  steps,
}: {
  hasActiveReasoning: boolean;
  isStreaming: boolean;
  onOpenChange: (open: boolean) => void;
  open: boolean | undefined;
  seconds: number;
  steps: ToolPart[];
}) => {
  const failed = steps.filter((part) => part.state === "output-error").length;

  let status: StepStatus | undefined;
  if (isStreaming) {
    status = "running";
  } else if (failed > 0) {
    status = "error";
  } else {
    status = undefined;
  }

  return (
    <Trace>
      <TraceCollapsible open={open ?? isStreaming} onOpenChange={onOpenChange}>
        <TraceCollapsibleTrigger>
          <TraceLine status={status}>
            <TraceIcon>
              <Gather
                color="var(--primary)"
                key={isStreaming ? "streaming" : "done"}
                playState={isStreaming ? "running" : "paused"}
                size={14}
              />
            </TraceIcon>
            <TraceTitle>Working</TraceTitle>
            <TraceDescription>{seconds}s</TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted>
          <Trace>
            {steps.map((part) => (
              <StepRow
                key={part.toolCallId}
                part={part}
                streaming={isStreaming}
              />
            ))}
            {hasActiveReasoning && isStreaming ? (
              <Step status="running" title="Thinking" />
            ) : null}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
};

const isToolPart = (part: ChatMessagePart): part is ToolPart =>
  part.type.startsWith("tool-");

export const AgentSteps = ({
  isStreaming,
  parts,
}: {
  isStreaming: boolean;
  parts: ChatMessagePart[];
}) => {
  const [open, setOpen] = useState<boolean>();
  const seconds = useTimer(isStreaming);
  const steps = parts.filter(isToolPart);
  const hasActiveReasoning = parts.some(
    (part) => part.type === "reasoning" && part.state === "streaming"
  );
  const hasAnswer = parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0
  );

  // The model briefly emits a message with no tool or reasoning part between
  // steps. Keep the panel visible while the turn is still working so it does
  // not flash off and on. The timer and open state live above this component,
  // so even a hidden panel cannot reset them.
  const isStarting = isStreaming && !hasAnswer;

  if (steps.length === 0 && !hasActiveReasoning && !isStarting) {
    return null;
  }

  return (
    <ChainOfThought
      hasActiveReasoning={hasActiveReasoning}
      isStreaming={isStreaming}
      onOpenChange={setOpen}
      open={open}
      seconds={seconds}
      steps={steps}
    />
  );
};
