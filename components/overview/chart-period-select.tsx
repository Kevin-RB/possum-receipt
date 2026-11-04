"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RANGE_ITEMS } from "@/lib/overview";
import type { RangeKey } from "@/lib/overview";

/** The period selector every overview chart carries, in one place. */
export const ChartPeriodSelect = ({
  label,
  onChange,
  value,
}: {
  /** The accessible name, because each chart has its own period. */
  label: string;
  onChange: (range: RangeKey) => void;
  value: RangeKey;
}) => (
  <Select
    items={RANGE_ITEMS}
    onValueChange={(next) => onChange(next as RangeKey)}
    value={value}
  >
    <SelectTrigger aria-label={label} size="sm">
      <SelectValue />
    </SelectTrigger>
    <SelectContent>
      <SelectGroup>
        {RANGE_ITEMS.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectGroup>
    </SelectContent>
  </Select>
);
