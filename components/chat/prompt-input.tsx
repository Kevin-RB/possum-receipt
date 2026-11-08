"use client";

import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useRef, useState } from "react";

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import type { ChatSelection } from "@/lib/chat/catalogue";

import { ModelPicker } from "./model-picker";

const PromptInputSubmit = ({
  canSend,
  isBusy,
  onStop,
}: {
  canSend: boolean;
  isBusy: boolean;
  onStop: () => void;
}) => {
  if (isBusy) {
    return (
      <InputGroupButton
        aria-label="Stop generating"
        className="ml-auto"
        onClick={onStop}
        size="icon-sm"
        type="button"
        variant="secondary"
      >
        <SquareIcon />
      </InputGroupButton>
    );
  }

  return (
    <InputGroupButton
      aria-label="Send"
      className="ml-auto"
      disabled={!canSend}
      size="icon-sm"
      type="submit"
      // A disabled `default` button dims lime to ~2:1 against the page.
      // `secondary` keeps the icon above 3:1 in both themes until there is
      // something to send.
      variant={canSend ? "default" : "secondary"}
    >
      <ArrowUpIcon />
    </InputGroupButton>
  );
};

export const PromptInput = ({
  isBusy,
  model,
  onChangeModel,
  onStop,
  onSubmit,
  placeholder,
  selections,
}: {
  isBusy: boolean;
  /** The catalogue entry the next message will be sent to. */
  model: ChatSelection;
  onChangeModel: (next: ChatSelection) => void;
  onStop: () => void;
  onSubmit: (text: string) => void;
  placeholder: string;
  /** Every model this deployment resolves, in catalogue order. */
  selections: readonly ChatSelection[];
}) => {
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const trimmed = input.trim();
  const canSend = trimmed.length > 0;

  const submit = () => {
    if (!canSend || isBusy) {
      return;
    }
    onSubmit(trimmed);
    setInput("");
  };

  return (
    <form
      className="flex w-full flex-col gap-2 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      ref={formRef}
    >
      <InputGroup
        onClick={(event) => {
          // `InputGroupAddon` forwards a tap to `querySelector("input")`, which
          // finds nothing here because the control is a textarea. Without this,
          // every pixel of the footer that is not the send button — over half
          // the composer on a phone — is dead, while `cursor-text` promises
          // otherwise.
          if ((event.target as HTMLElement).closest("button")) {
            return;
          }
          textareaRef.current?.focus();
        }}
      >
        <InputGroupTextarea
          className="min-h-10"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            // `isComposing` guards against Enter firing mid-IME input, which
            // would submit a half-typed Japanese or Chinese character.
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
          placeholder={placeholder}
          ref={textareaRef}
          rows={1}
          value={input}
        />
        <InputGroupAddon align="block-end">
          <ModelPicker
            onChange={onChangeModel}
            selections={selections}
            value={model}
          />
          <PromptInputSubmit
            canSend={canSend}
            isBusy={isBusy}
            onStop={onStop}
          />
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
};
