// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatSelection } from "@/lib/chat/catalogue";
import { USER_ERROR } from "@/lib/errors";

/**
 * The request is what this pins: the selection the reader sees on the picker
 * has to be the model named in the body of the next send, including after a
 * mid-thread switch. `useChat` is stubbed down to the one thing that matters
 * here — it hands its transport the latest options on every render — so the
 * body `chat.tsx` builds can be read without a live agent or a provider.
 */
const hooks = vi.hoisted(() => ({
  error: undefined as unknown,
  messages: [] as unknown[],
  status: "ready" as "error" | "ready" | "streaming" | "submitted",
  transport: undefined as unknown,
}));

// @ts-expect-error the stub only needs the parts the component destructures
vi.mock(import("@ai-sdk/react"), () => ({
  useChat: (options: { transport: unknown }) => {
    hooks.transport = options.transport;
    return {
      addToolOutput: () => 0,
      error: hooks.error,
      id: "chat-1",
      messages: hooks.messages,
      sendMessage: () => 0,
      setMessages: () => 0,
      status: hooks.status,
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

const chat = () => <Chat firstName="Kevin" selections={[deepseek, local]} />;

describe(Chat, () => {
  beforeEach(() => {
    bodies.length = 0;
    hooks.error = undefined;
    hooks.messages = [];
    hooks.status = "ready";
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

  it("names the composer, in the empty state and in a conversation", () => {
    const view = renderChat();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();

    hooks.messages = [
      {
        id: "m1",
        parts: [{ text: "how much this month?", type: "text" }],
        role: "user",
      },
    ];
    view.rerender(chat());

    // The same composer moves to the footer of the thread; the placeholder
    // changed, but the name did not.
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
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

  describe("the status region", () => {
    it("is mounted empty before anything has been asked", () => {
      renderChat();

      // A live region inserted together with its first message is usually not
      // announced at all, so it exists — empty — from the first render.
      expect(screen.getByRole("status").textContent).toBe("");
    });

    it("says the answer is ready once a response completes", async () => {
      const view = renderChat();
      expect(screen.getByRole("status").textContent).toBe("");

      hooks.status = "streaming";
      view.rerender(chat());

      // Nothing is said while the turn is in flight: "Thinking…" is an
      // interstitial state, and announcing it is noise.
      expect(screen.getByRole("status").textContent).toBe("");

      hooks.messages = [
        {
          id: "m1",
          parts: [{ text: "how much this month?", type: "text" }],
          role: "user",
        },
        {
          id: "m2",
          parts: [{ text: "About $420.", type: "text" }],
          role: "assistant",
        },
      ];
      hooks.status = "ready";
      view.rerender(chat());

      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toBe("Answer ready");
      });
    });

    it("announces a failure in the catalogue's own words", async () => {
      const view = renderChat();

      hooks.status = "streaming";
      view.rerender(chat());

      hooks.error = new Error(USER_ERROR.unauthorized);
      hooks.status = "error";
      view.rerender(chat());

      await waitFor(() => {
        expect(screen.getByRole("status").textContent).toBe(
          USER_ERROR.unauthorized
        );
      });
    });
  });
});
