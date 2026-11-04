import type { DateRange } from "react-day-picker";
import "temporal-polyfill/global";

import {
  localDayToISODate,
  tryWallClockToISODate,
} from "@/lib/receipt/datetime";

export type DateRangeFilterValue = Partial<DateRange>;

interface FilterableRow {
  getValue: (columnId: string) => unknown;
}

export const dateRangeFilterFn = (
  row: FilterableRow,
  columnId: string,
  value: DateRangeFilterValue
): boolean => {
  const { from, to } = value;
  if (!from && !to) {
    return true;
  }
  const raw = row.getValue(columnId);
  // The row value is the receipt's printed wall clock; the range bounds are
  // calendar days carried at browser-local midnight.
  const dateString =
    typeof raw === "string" ? tryWallClockToISODate(raw) : undefined;
  if (!dateString) {
    return false;
  }
  if (from && dateString < localDayToISODate(from)) {
    return false;
  }
  if (to && dateString > localDayToISODate(to)) {
    return false;
  }
  return true;
};
