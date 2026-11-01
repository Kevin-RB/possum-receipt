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

export const Chat = ({ firstName }: { firstName: string }) => {
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
    transport: new DefaultChatTransport({
      api: "/api/chat",
      // The browser is the clock in front of the reader, and a function is read
      // per request: the edge's `tz` cookie is only a copy taken on the last
      // page load, and this is where the viewer actually is now.
      body: () => ({
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
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
                  onStop={stop}
                  onSubmit={(text) => sendMessage({ text })}
                  placeholder="How can I help you today?"
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
              onStop={stop}
              onSubmit={(text) => sendMessage({ text })}
              placeholder="Ask about your receipts…"
            />
            {busy ? null : (
              <Button
                className="self-start"
                onClick={() => setMessages([])}
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
