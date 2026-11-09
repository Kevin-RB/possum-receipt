// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSelection } from "@/lib/chat/catalogue";

/**
 * The request is what this pins: the selection the reader sees on the picker
 * has to be the model named in the body of the next send, including after a
 * mid-thread switch. `useChat` is stubbed down to the one thing that matters
 * here — it hands its transport the latest options on every render — so the
 * body `chat.tsx` builds can be read without a live agent or a provider.
 */
const hooks = vi.hoisted(() => ({
  messages: [] as unknown[],
  transport: undefined as unknown,
}));

// @ts-expect-error the stub only needs the parts the component destructures
vi.mock(import("@ai-sdk/react"), () => ({
  useChat: (options: { transport: unknown }) => {
    hooks.transport = options.transport;
    return {
      addToolOutput: () => 0,
      error: undefined,
      id: "chat-1",
      messages: hooks.messages,
      sendMessage: () => 0,
      setMessages: () => 0,
      status: "ready",
      stop: () => 0,
    };
  },
}));

const { Chat } = await import("./chat");

const deepseek: ChatSelection = {
  model: "deepseek/deepseek-v4.1-flash-1017",
  provider: "openrouter",
};

const local: ChatSelection = {
  model: "google/gemma-4-e4b",
  provider: "local",
};

const bodies: unknown[] = [];

/**
 * jsdom's `localStorage` is shadowed by Node's own (undefined without a
 * `--localstorage-file`), so a recording stub stands in. Anything the chat
 * persists would have to go through `setItem`, and the ticket promises it
 * stores nothing.
 */
const writes: string[] = [];

const recordingStorage = (): Storage => ({
  clear: () => 0,
  getItem: () => null,
  key: () => null,
  length: 0,
  removeItem: () => 0,
  setItem: (key: string) => writes.push(key),
});

const send = async () => {
  const transport = hooks.transport as {
    sendMessages: (options: unknown) => Promise<unknown>;
  };

  await transport.sendMessages({
    abortSignal: new AbortController().signal,
    chatId: "chat-1",
    messageId: undefined,
    messages: [
      {
        id: "m1",
        parts: [{ text: "how much this month?", type: "text" }],
        role: "user",
      },
    ],
    trigger: "submit-message",
  });

  return bodies.at(-1);
};

const pickLocal = async () => {
  fireEvent.mouseDown(screen.getByLabelText(/^Choose a model/u));

  await waitFor(() => {
    expect(screen.getByRole("menu")).toBeTruthy();
  });
  fireEvent.click(screen.getByText("local (gemma-4-e4b)"));
};

const renderChat = () =>
  render(<Chat firstName="Kevin" selections={[deepseek, local]} />);

describe(Chat, () => {
  beforeEach(() => {
    bodies.length = 0;
    hooks.messages = [];
    writes.length = 0;
    vi.stubGlobal("localStorage", recordingStorage());
    vi.stubGlobal("sessionStorage", recordingStorage());
    vi.stubGlobal("fetch", (input: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Promise.resolve(
        new Response("", {
          headers: { "content-type": "text/event-stream" },
          status: 200,
        })
      );
    });
  });

  it("starts on the catalogue's first entry and sends it with the message", async () => {
    renderChat();

    expect(
      screen.getByLabelText("Choose a model: deepseek-v4.1-flash-1017")
    ).toBeTruthy();
    await expect(send()).resolves.toMatchObject({
      messages: [
        {
          parts: [{ text: "how much this month?", type: "text" }],
          role: "user",
        },
      ],
      model: deepseek.model,
      provider: deepseek.provider,
    });
  });

  it("sends the new model with the next message after a mid-thread switch", async () => {
    renderChat();

    await pickLocal();

    expect(
      screen.getByLabelText("Choose a model: local (gemma-4-e4b)")
    ).toBeTruthy();
    // Nothing is filtered or reset: the same messages leave, under the new
    // model. The whole prior thread riding along is visible in the browser run
    // behind #225, which this stubbed hook cannot reproduce.
    await expect(send()).resolves.toMatchObject({
      messages: [
        {
          parts: [{ text: "how much this month?", type: "text" }],
          role: "user",
        },
      ],
      model: local.model,
      provider: local.provider,
    });
  });

  it("offers the picker in a conversation, not only in the empty state", () => {
    hooks.messages = [
      {
        id: "m1",
        parts: [{ text: "how much this month?", type: "text" }],
        role: "user",
      },
    ];

    renderChat();

    // The conversation branch, not the empty state: the model choice survives
    // the first message.
    expect(screen.getByText("New chat")).toBeTruthy();
    expect(
      screen.getByLabelText("Choose a model: deepseek-v4.1-flash-1017")
    ).toBeTruthy();
  });

  it("starts a new chat on the default, so the choice belongs to the conversation", async () => {
    hooks.messages = [
      {
        id: "m1",
        parts: [{ text: "how much this month?", type: "text" }],
        role: "user",
      },
    ];

    renderChat();
    await pickLocal();
    expect(
      screen.getByLabelText("Choose a model: local (gemma-4-e4b)")
    ).toBeTruthy();

    fireEvent.click(screen.getByText("New chat"));

    expect(
      screen.getByLabelText("Choose a model: deepseek-v4.1-flash-1017")
    ).toBeTruthy();
  });

  it("starts a reload on the default, having stored nothing", async () => {
    const first = renderChat();
    await pickLocal();
    expect(
      screen.getByLabelText("Choose a model: local (gemma-4-e4b)")
    ).toBeTruthy();
    first.unmount();

    renderChat();

    expect(
      screen.getByLabelText("Choose a model: deepseek-v4.1-flash-1017")
    ).toBeTruthy();
    expect(writes).toStrictEqual([]);
  });
});
