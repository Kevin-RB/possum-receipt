import { createAgentUIStreamResponse, validateUIMessages } from "ai";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { createChatAgent } from "@/lib/chat/agent";
import { chatErrorCode } from "@/lib/chat/errors";
import { buildChatTools } from "@/lib/chat/tools";
import type { ChatUIMessage } from "@/lib/chat/tools";
import { discardUntrustedToolOutputs } from "@/lib/chat/trust";
import { reportError, USER_ERROR } from "@/lib/errors";
import { resolveToday, resolveTimezone } from "@/lib/time";
import { viewerTimezone } from "@/lib/viewer";

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

  const tools = buildChatTools(session.user.id);

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

  // The browser names its own zone — it is the clock in front of the reader, and
  // the cookie is only a page-request copy of it. A value that is not a zone
  // name is dropped by `resolveTimezone`, falling through to the account's.
  const timezone = resolveTimezone(
    (body as { timezone?: unknown }).timezone,
    await viewerTimezone(),
    session.user.timezone
  );

  const agent = await createChatAgent(
    session.user.id,
    resolveToday(timezone),
    timezone
  );

  return createAgentUIStreamResponse({
    abortSignal: request.signal,
    agent,
    // The UI shows the returned string, so it comes from the catalogue and is
    // written for a reader. The error itself — provider URL, model id, retry
    // causes — is logged instead: an error part carries no cause, so this is
    // the only place it exists.
    onError: (error) => {
      reportError("chat", error);
      return USER_ERROR[chatErrorCode(error)];
    },
    // Everything past this point came off the wire. See `lib/chat/trust.ts`.
    uiMessages: discardUntrustedToolOutputs(messages),
  });
};
