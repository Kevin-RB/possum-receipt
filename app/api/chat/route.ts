import { createAgentUIStreamResponse, validateUIMessages } from "ai";
import { NextResponse } from "next/server";

import { CHAT_MODEL } from "@/lib/ai/provider";
import { auth } from "@/lib/auth";
import { createChatAgent } from "@/lib/chat/agent";
import { chatErrorCode, chatFailureLog } from "@/lib/chat/errors";
import { buildChatTools } from "@/lib/chat/tools";
import type { ChatUIMessage } from "@/lib/chat/tools";
import { discardUntrustedToolOutputs } from "@/lib/chat/trust";
import { reportError, USER_ERROR } from "@/lib/errors";
import { resolveToday } from "@/lib/time";
import { viewerZone } from "@/lib/viewer";

/** The app runs against a local model, so latency is bound by OCR-free local inference. */
export const maxDuration = 60;

export const POST = async (request: Request) => {
  const session = await auth.api.getSession({ headers: request.headers });

  if (!session) {
    return NextResponse.json(
      { error: USER_ERROR.unauthorized },
      { status: 401 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // The same chain the pages walk, through the same function — not a second
  // composition of it, which is how the assistant and the charts end up on
  // different days. A chat-only candidate would be the same mistake in the
  // other direction: the browser's zone is already on the request.
  const timezone = await viewerZone(session.user.timezone);
  const today = resolveToday(timezone);

  // One `today` for the whole request: the tools resolve a named period against
  // this date, and the prompt states it, so "last month" cannot mean one window
  // in the sentence the model reads and another in the query it runs.
  const tools = buildChatTools(session.user.id, today);

  // The body is client-supplied, so validate the shape of every message and
  // tool part before it reaches the model.
  let messages: ChatUIMessage[];
  try {
    messages = await validateUIMessages<ChatUIMessage>({
      messages: (body as { messages?: unknown })?.messages,
      tools: tools as Parameters<typeof validateUIMessages>[0]["tools"],
    });
  } catch {
    return NextResponse.json({ error: "Invalid messages." }, { status: 400 });
  }

  const agent = await createChatAgent(session.user.id, today, timezone);

  return createAgentUIStreamResponse({
    abortSignal: request.signal,
    agent,
    // The UI shows the returned string, so it comes from the catalogue and is
    // written for a reader. The error itself — provider URL, model id, retry
    // causes — is logged instead: an error part carries no cause, so this is
    // the only place it exists.
    onError: (error) => {
      // A projection, not the error: it carries the messages sent to the model
      // and a URL that may hold a key. See `chatFailureLog`.
      reportError("chat", chatFailureLog(error, CHAT_MODEL));
      return USER_ERROR[chatErrorCode(error)];
    },
    // Everything past this point came off the wire. See `lib/chat/trust.ts`.
    uiMessages: discardUntrustedToolOutputs(messages),
  });
};
