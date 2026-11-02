import { createAgentUIStreamResponse, validateUIMessages } from "ai";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { createChatAgent } from "@/lib/chat/agent";
import { chatErrorCode } from "@/lib/chat/errors";
import { buildChatTools } from "@/lib/chat/tools";
import type { ChatUIMessage } from "@/lib/chat/tools";
import { discardUntrustedToolOutputs } from "@/lib/chat/trust";
import { reportError, USER_ERROR } from "@/lib/errors";
import {
  isTimezone,
  resolveToday,
  resolveTimezone,
  TIMEZONE_COOKIE,
} from "@/lib/time";
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

  // The same chain the pages walk, in the same order: the edge, then the cookie
  // it seeded, then the browser's own zone, then the account. Asking the same
  // sources in the same order is what keeps the assistant and the charts on the
  // same day — two carriers that disagreed would have the app answering "today"
  // two ways, and a value that is not a zone name is dropped by `resolveTimezone`
  // rather than allowed to win.
  const wireZone = await viewerTimezone();
  const bodyZone = (body as { timezone?: unknown }).timezone;

  const timezone = resolveTimezone(wireZone, bodyZone, session.user.timezone);

  // The one piece of evidence only a chat turn has. When nothing on the wire
  // supplied a zone — no edge header, no cookie, or a header Cloudflare could
  // not fill — the browser's answer is the best one available, and pinning it
  // here means the pages read it on their next request and stop falling back to
  // the account's zone. Without the pin, a page would say the reader's home
  // day while the assistant said the day they are actually on.
  const pinnedZone =
    isTimezone(wireZone) || !isTimezone(bodyZone) ? undefined : bodyZone;

  const agent = await createChatAgent(
    session.user.id,
    resolveToday(timezone),
    timezone
  );

  const response = await createAgentUIStreamResponse({
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

  if (!pinnedZone) {
    return response;
  }

  // Rewrapped rather than hand-serialised, so the cookie carries the same
  // attributes `proxy.ts` writes — `NextResponse.cookies.set` owns the encoding
  // and the `Set-Cookie` shape.
  const pinned = new NextResponse(response.body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText,
  });
  pinned.cookies.set(TIMEZONE_COOKIE, pinnedZone, {
    path: "/",
    sameSite: "lax",
  });

  return pinned;
};
