"use client";

import { useMemo } from "react";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** The sentinel for "no zone recorded" — a select cannot carry `undefined`. */
const NO_ZONE = "__none__";

/**
 * Every zone the runtime knows, by IANA name.
 *
 * Read once at module load rather than per render: it is the same list for
 * every receipt on the page, and `supportedValuesOf` walks the whole table.
 */
const ZONE_NAMES = Intl.supportedValuesOf("timeZone");

/**
 * Picks the zone a receipt was printed in (#200).
 *
 * The list is the runtime's own — no per-country grammar, no lookup service —
 * and an unknown stored value is offered too rather than silently changing the
 * receipt's answer: `Intl` may know a zone this runtime spells differently.
 */
export const TimezoneSelect = ({
  onValueChange,
  value,
}: {
  onValueChange: (value: string | undefined) => void;
  value: string | undefined;
}) => {
  const items = useMemo(() => {
    const names =
      value && !ZONE_NAMES.includes(value)
        ? [value, ...ZONE_NAMES]
        : ZONE_NAMES;

    return [
      { label: "Not set", value: NO_ZONE },
      ...names.map((zone) => ({ label: zone, value: zone })),
    ];
  }, [value]);

  return (
    <Select
      items={items}
      onValueChange={(next) =>
        onValueChange(next === NO_ZONE ? undefined : (next ?? undefined))
      }
      value={value ?? NO_ZONE}
    >
      <SelectTrigger aria-label="Timezone" className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
};
