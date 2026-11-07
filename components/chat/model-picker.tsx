"use client";

import { ChevronDownIcon } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InputGroupButton } from "@/components/ui/input-group";
import type { ChatSelection } from "@/lib/chat/catalogue";
import { modelGroups, modelLabel, selectionKey } from "@/lib/chat/model-labels";

/**
 * The chat's model picker: one dropdown in the composer footer, drawing only
 * what the server resolved. It holds no list of its own and no default — the
 * page passes the catalogue's resolved entries and the caller owns the
 * selection, which is what keeps the route and the picker on the same list.
 */
const radioItems = (selections: readonly ChatSelection[]) =>
  selections.map((selection) => (
    <DropdownMenuRadioItem
      closeOnClick
      key={selectionKey(selection)}
      value={selectionKey(selection)}
    >
      {modelLabel(selection)}
    </DropdownMenuRadioItem>
  ));

export const ModelPicker = ({
  choices,
  onChange,
  value,
}: {
  /** Every model this deployment resolves, in catalogue order. */
  choices: readonly ChatSelection[];
  onChange: (next: ChatSelection) => void;
  value: ChatSelection;
}) => {
  const groups = modelGroups(choices);
  // Two providers mean the row alone is ambiguous and needs its heading; one
  // means the heading would repeat the only provider on every line.
  const grouped = groups.length > 1;

  const select = (key: string) => {
    const next = choices.find((choice) => selectionKey(choice) === key);
    if (next) {
      onChange(next);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            aria-label="Choose a model"
            // `Button` is `shrink-0`, so `min-w-0` alone never truncates: the
            // label would grow the row until the send button was pushed out.
            // Allowing the trigger to shrink is what makes `truncate` on the
            // label bite, and the size still comes from the component.
            className="min-w-0 shrink"
            size="sm"
            variant="ghost"
          />
        }
      >
        <span className="truncate">{modelLabel(value)}</span>
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          onValueChange={(key) => {
            if (typeof key === "string") {
              select(key);
            }
          }}
          value={selectionKey(value)}
        >
          {grouped ? (
            groups.map((group) => (
              <DropdownMenuGroup key={group.provider}>
                <DropdownMenuLabel>{group.heading}</DropdownMenuLabel>
                {radioItems(group.selections)}
              </DropdownMenuGroup>
            ))
          ) : (
            <DropdownMenuGroup>{radioItems(choices)}</DropdownMenuGroup>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
