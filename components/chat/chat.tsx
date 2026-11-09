"use client";

import { useChat } from "@ai-sdk/react";
import {
  DefaultChatTransport,
  lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { Leap } from "loading-dev";
import { PlusIcon } from "lucide-react";
import { useSyncExternalStore, useState } from "react";

import { PossumMark } from "@/components/brand/possum-mark";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
} from "@/components/ui/empty";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
} from "@/components/ui/message-scroller";
import { Trace, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace";
import type { ChatSelection } from "@/lib/chat/catalogue";
import { chatErrorText } from "@/lib/chat/errors";
import { greetingFor } from "@/lib/chat/greeting";
import { isLastStreaming } from "@/lib/chat/message-parts";
import type {
  AskUserAnswers,
  AskUserToolPart,
  ChatUIMessage,
} from "@/lib/chat/tools";
import { cn } from "@/lib/utils";

import { ChatMessage } from "./chat-message";
import { ChatDebugPanel } from "./debug-panel";
import { PromptInput } from "./prompt-input";
import { QuestionCard } from "./question-card";
import { Suggestions } from "./suggestions";

/**
 * Throttles client re-renders while tokens stream in. Surfaced in the debug
 * panel, since it is easy to mistake for a stalled response.
 */
const THROTTLE_MS = 50;

/**
 * The panel is behind a compile-time constant so the whole branch — component
 * and props — is dropped from production bundles rather than merely hidden.
 */
const isDev = process.env.NODE_ENV === "development";

/**
 * The greeting is read once on mount and never changes, so the store has
 * nothing to subscribe to. `getServerSnapshot` returning `null` is what stops
 * React from hydrating a server-rendered greeting that would then be replaced.
 */
const subscribeToClock = () => () => 0;

const TopFade = () => {
  const { start } = useMessageScrollerScrollable();

  return (
    <div
      aria-hidden="true"
      className={cn(
        "from-background pointer-events-none absolute inset-x-0 top-0 h-8 bg-linear-to-b to-transparent transition-opacity duration-200",
        start ? "opacity-100" : "opacity-0"
      )}
    />
  );
};

const findPendingQuestion = (
  message: ChatUIMessage | undefined
): AskUserToolPart | undefined =>
  message?.role === "assistant"
    ? message.parts.find(
        (part): part is AskUserToolPart =>
          part.type === "tool-ask_user" &&
          (part.state === "input-streaming" || part.state === "input-available")
      )
    : undefined;

export const Chat = ({
  firstName,
  selections,
}: {
  firstName: string;
  /**
   * The catalogue's resolved entries, in its own order. The page reads them on
   * the server, so the browser holds no model id of its own and cannot offer
   * one the route would refuse.
   */
  selections: readonly ChatSelection[];
}) => {
  // Per conversation and client-side only: a switch applies to the next
  // message and the whole thread goes to the new model, nothing is stored, and
  // a new conversation — a reload or "New chat" — starts on the default, which
  // is the catalogue's first entry, the same one the route falls back to.
  const [selection, setSelection] = useState<ChatSelection>(selections[0]);

  const {
    addToolOutput,
    error,
    id: chatId,
    messages,
    sendMessage,
    setMessages,
    status,
    stop,
  } = useChat<ChatUIMessage>({
    // Resumes the turn once the user answers the ask_user questionnaire:
    // the unanswered tool call is the signal that the agent is waiting.
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    throttle: THROTTLE_MS,
    // The browser's zone is already on the request as `cf-timezone`, put there
    // by the edge, so it is not sent again. The model is: it is the one thing
    // about this request the reader chose, and it rides on every send —
    // including the automatic resend after `ask_user` — because `useChat`
    // reads the latest transport at send time.
    transport: new DefaultChatTransport({
      api: "/api/chat",
      body: selection,
    }),
  });

  const busy = status === "submitted" || status === "streaming";
  const isEmpty = messages.length === 0;
  const lastMessage = messages.at(-1);
  const pendingQuestion = findPendingQuestion(lastMessage);

  // The empty state's entrance is a bridge back from a conversation, not a page
  // entry animation: `/` is the front door, so arriving here is core navigation
  // and gets no motion. Adjusted during render rather than in an effect, the
  // same pattern `upload-flow.tsx` uses — the flag only ever flips one way, so
  // it settles after the first message.
  const [hasConversed, setHasConversed] = useState(false);
  if (!isEmpty && !hasConversed) {
    setHasConversed(true);
  }

  // Null on the server and the first client render, so there is no wrong
  // greeting to correct — the title is filled in once the browser's clock is
  // available. See `lib/chat/greeting.ts`.
  const greeting = useSyncExternalStore(
    subscribeToClock,
    () => greetingFor(firstName),
    () => null
  );

  const debugPanel = isDev ? (
    <ChatDebugPanel
      chatId={chatId}
      error={error}
      messages={messages}
      status={status}
      throttle={THROTTLE_MS}
    />
  ) : null;

  return (
    <div className="flex h-full w-full flex-col">
      {isEmpty ? (
        // A column, so the dev panel sits below the greeting instead of
        // competing with it for width on a phone.
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col",
            hasConversed && "enter-rise"
          )}
        >
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <Empty>
              <EmptyHeader>
                {/* No reserved height needed: the mark renders unconditionally
                    and is taller than the text, so the row cannot change height
                    when the greeting eases in after hydration — see
                    `lib/chat/greeting.ts`. */}
                <div className="flex items-center justify-center gap-3">
                  <PossumMark className="size-16" ground="var(--background)" />
                  {greeting ? (
                    <h1 className="font-heading text-xl font-semibold tracking-tight sm:text-2xl">
                      {greeting}
                    </h1>
                  ) : null}
                </div>
                <EmptyDescription>
                  Ask about your spending — for example “how much did I spend on
                  groceries last month?”
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="w-full max-w-3xl">
                <PromptInput
                  isBusy={busy}
                  model={selection}
                  onChangeModel={setSelection}
                  onStop={stop}
                  onSubmit={(text) => sendMessage({ text })}
                  placeholder="How can I help you today?"
                  selections={selections}
                />
                <Suggestions onSelect={(text) => sendMessage({ text })} />
              </EmptyContent>
            </Empty>
          </div>
          {debugPanel}
        </div>
      ) : (
        <>
          <div className="enter-rise relative min-h-0 flex-1 overflow-hidden">
            <MessageScrollerProvider autoScroll>
              <MessageScroller>
                <MessageScrollerViewport>
                  {/* The scroller content owns its spacing, so the phone
                      gutter goes on a plain wrapper around it. */}
                  <div className="flex h-full flex-col px-4">
                    <MessageScrollerContent
                      aria-busy={busy}
                      className="mx-auto w-full max-w-3xl"
                    >
                      {messages.map((message) => (
                        <MessageScrollerItem
                          key={message.id}
                          messageId={message.id}
                          scrollAnchor={message.role === "user"}
                        >
                          <ChatMessage
                            isStreaming={isLastStreaming(
                              message,
                              lastMessage?.id,
                              busy
                            )}
                            message={message}
                          />
                        </MessageScrollerItem>
                      ))}

                      {status === "submitted" ? (
                        <MessageScrollerItem messageId="thinking">
                          <Trace>
                            <TraceLine aria-live="polite" status="running">
                              <TraceIcon>
                                <Leap size={14} />
                              </TraceIcon>
                              <TraceTitle>Thinking…</TraceTitle>
                            </TraceLine>
                          </Trace>
                        </MessageScrollerItem>
                      ) : null}
                    </MessageScrollerContent>
                  </div>

                  {pendingQuestion ? (
                    <QuestionCard
                      onAnswer={(toolCallId: string, answers: AskUserAnswers) =>
                        addToolOutput({
                          output: answers,
                          tool: "ask_user",
                          toolCallId,
                        })
                      }
                      part={pendingQuestion}
                    />
                  ) : null}
                </MessageScrollerViewport>
                <MessageScrollerButton />
              </MessageScroller>
              <TopFade />
            </MessageScrollerProvider>
          </div>

          <div className="enter-rise mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 py-3">
            {error ? (
              <p className="text-destructive text-xs" role="alert">
                {chatErrorText(error)}
              </p>
            ) : null}
            <PromptInput
              isBusy={busy}
              model={selection}
              onChangeModel={setSelection}
              onStop={stop}
              onSubmit={(text) => sendMessage({ text })}
              placeholder="Ask about your receipts…"
              selections={selections}
            />
            {busy ? null : (
              <Button
                className="self-start"
                onClick={() => {
                  setMessages([]);
                  setSelection(selections[0]);
                }}
                size="sm"
                type="button"
                variant="ghost"
              >
                <PlusIcon />
                New chat
              </Button>
            )}
          </div>
          {debugPanel}
        </>
      )}
    </div>
  );
};
