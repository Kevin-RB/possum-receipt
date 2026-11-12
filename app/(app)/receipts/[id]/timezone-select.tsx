"use client";

import { useMemo } from "react";

import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { InputGroupAddon, InputGroupButton } from "@/components/ui/input-group";

/** The list's entry for "no zone recorded" — the value is empty, never null. */
const NOT_SET = "Not set";

/**
 * Every zone the runtime knows, by IANA name.
 *
 * Read once at module load rather than per render: it is the same list for
 * every receipt on the page, and `supportedValuesOf` walks the whole table.
 */
const ZONE_NAMES = Intl.supportedValuesOf("timeZone");

/**
 * Case- and separator-insensitive matching. An IANA name spells a place with
 * "/" and "_" where someone typing it uses spaces and lowercase, so "new york"
 * has to reach America/New_York and "bris" Australia/Brisbane.
 */
const normalizeZone = (value: string) =>
  value.toLowerCase().replaceAll(/[/_]/gu, " ").replaceAll(/\s+/gu, " ").trim();

const matchesZone = (zone: string, query: string) =>
  normalizeZone(zone).includes(normalizeZone(query));

/**
 * Picks the zone a receipt was printed in (#200).
 *
 * A searchable list rather than a plain select: the runtime knows around 400
 * zones, and scrolling them is not a way to find one. The list is still the
 * runtime's own — no per-country grammar, no lookup service — and an unknown
 * stored value is offered too rather than silently changing the receipt's
 * answer: `Intl` may know a zone this runtime spells differently.
 */
export const TimezoneSelect = ({
  describedBy,
  id,
  invalid,
  labelledBy,
  onValueChange,
  value,
}: {
  /** The ids of the help text and any error, when they are rendered. */
  describedBy: string | undefined;
  /** The input's id, so the field's visible label can point at it. */
  id: string;
  invalid: boolean;
  /** The id of the visible field label, which names the input. */
  labelledBy: string;
  onValueChange: (value: string | undefined) => void;
  value: string | undefined;
}) => {
  const items = useMemo(() => {
    const names =
      value && !ZONE_NAMES.includes(value)
        ? [value, ...ZONE_NAMES]
        : ZONE_NAMES;

    return [NOT_SET, ...names];
  }, [value]);

  return (
    <Combobox
      autoHighlight
      filter={matchesZone}
      items={items}
      onValueChange={(next: string | null) =>
        onValueChange(next === null || next === NOT_SET ? undefined : next)
      }
      value={value ?? NOT_SET}
    >
      <ComboboxInput
        aria-describedby={describedBy}
        aria-invalid={invalid}
        // The visible field label names the control. The input carries the
        // current zone as its value, so the label stays the label.
        aria-labelledby={labelledBy}
        className="w-full"
        id={id}
        placeholder="Search timezones"
        showTrigger={false}
      >
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            aria-label="Show timezones"
            render={<ComboboxTrigger />}
            size="icon-xs"
            variant="ghost"
          />
        </InputGroupAddon>
      </ComboboxInput>
      <ComboboxContent>
        <ComboboxEmpty>No timezones found.</ComboboxEmpty>
        <ComboboxList>
          {(zone: string) => (
            <ComboboxItem key={zone} value={zone}>
              {zone}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
};
