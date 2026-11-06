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

export interface CatalogueEntry {
  provider: string;
  model: string;
  label: string;
}

const keyOf = (entry: CatalogueEntry) => `${entry.provider}:${entry.model}`;

const PROVIDER_LABELS: Record<string, string> = {
  local: "Local",
  openrouter: "OpenRouter",
};

const providerLabel = (provider: string) =>
  PROVIDER_LABELS[provider] ?? provider;

/**
 * Prototype of the chat model picker. The catalogue arrives resolved from the
 * server, so this only renders what it is given: one dropdown, flat unless
 * more than one provider is present.
 */
export const ModelPicker = ({
  entries,
  value,
  onChange,
}: {
  entries: CatalogueEntry[];
  value: string;
  onChange: (next: string) => void;
}) => {
  const selected =
    entries.find((entry) => keyOf(entry) === value) ?? entries[0];
  const providers = [...new Set(entries.map((entry) => entry.provider))];
  const grouped = providers.length > 1;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <InputGroupButton
            aria-label="Choose a model"
            size="sm"
            variant="ghost"
          />
        }
      >
        {selected?.label ?? "No model"}
        <ChevronDownIcon data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-56">
        <DropdownMenuRadioGroup
          onValueChange={(next) => {
            if (typeof next === "string") {
              onChange(next);
            }
          }}
          value={value}
        >
          {grouped ? (
            providers.map((provider) => (
              <DropdownMenuGroup key={provider}>
                <DropdownMenuLabel key={provider}>
                  {providerLabel(provider)}
                </DropdownMenuLabel>
                {entries
                  .filter((entry) => entry.provider === provider)
                  .map((entry) => (
                    <DropdownMenuRadioItem
                      closeOnClick
                      key={keyOf(entry)}
                      value={keyOf(entry)}
                    >
                      {entry.label}
                    </DropdownMenuRadioItem>
                  ))}
              </DropdownMenuGroup>
            ))
          ) : (
            <DropdownMenuGroup>
              {entries.map((entry) => (
                <DropdownMenuRadioItem
                  closeOnClick
                  key={keyOf(entry)}
                  value={keyOf(entry)}
                >
                  {entry.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuGroup>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
