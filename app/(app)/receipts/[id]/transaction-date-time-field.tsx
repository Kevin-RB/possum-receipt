"use client";

import { CalendarIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  formatReceiptDateTime,
  plainDateToLocalDay,
  receiptDayToLocalString,
  receiptLocalStringToDay,
  receiptLocalStringToTime,
} from "@/lib/receipt/datetime";

interface TransactionDateTimeFieldProps {
  onValueChange: (value: string) => void;
  /** The viewer's day, resolved on the server — the calendar's ceiling. */
  today: string;
  value: string | undefined;
}

/**
 * Picks the transaction datetime as a calendar day plus a time of day, using
 * the same `Calendar` in a `Popover` as the date-range filter on the receipts
 * page so both screens share one calendar.
 *
 * A calendar has no notion of a time of day, so the two are edited separately:
 * picking a day rewrites the date and leaves the time alone, and the time
 * input rewrites the time and leaves the day alone.
 */
export const TransactionDateTimeField = ({
  onValueChange,
  today,
  value,
}: TransactionDateTimeFieldProps) => {
  const [open, setOpen] = useState(false);

  const day = receiptLocalStringToDay(value);
  const time = receiptLocalStringToTime(value);

  // A receipt cannot be bought in the future, and "the future" is the viewer's
  // own calendar — resolved on the server, since a component that read its own
  // clock would be server-rendered in the server's zone and hydrated in theirs.
  const latestDay = useMemo(
    () => plainDateToLocalDay(Temporal.PlainDate.from(today)),
    [today]
  );

  const label = value ? formatReceiptDateTime(value) : "Select a date";

  return (
    <div className="flex flex-col gap-2">
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger
          aria-label={`Transaction date and time: ${label}`}
          className="justify-start"
          id="transaction-datetime"
          render={
            <Button variant="outline">
              <CalendarIcon data-icon="inline-start" />
              {label}
            </Button>
          }
        />
        <PopoverContent align="start" className="w-auto">
          <Calendar
            defaultMonth={day}
            disabled={{ after: latestDay }}
            mode="single"
            onSelect={(next) => {
              // Selecting the selected day again clears it, so an already-chosen
              // date can be undone from the calendar itself.
              onValueChange(next ? receiptDayToLocalString(next, time) : "");
              setOpen(false);
            }}
            selected={day}
          />
          {day ? (
            <div className="border-t p-1">
              <Button
                onClick={() => {
                  onValueChange("");
                  setOpen(false);
                }}
                size="sm"
                variant="ghost"
              >
                Clear date
              </Button>
            </div>
          ) : null}
        </PopoverContent>
      </Popover>
      <Input
        aria-label="Transaction time"
        disabled={!day}
        onChange={(event) => {
          if (day) {
            onValueChange(receiptDayToLocalString(day, event.target.value));
          }
        }}
        step="60"
        type="time"
        value={time ?? ""}
      />
    </div>
  );
};
