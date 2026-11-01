"use client";

import { CalendarIcon } from "lucide-react";
import { useState } from "react";

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
  receiptDayToLocalString,
  receiptLocalStringToDay,
  receiptLocalStringToTime,
  receiptToday,
} from "@/lib/receipt/datetime";

interface TransactionDateTimeFieldProps {
  onValueChange: (value: string) => void;
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
  value,
}: TransactionDateTimeFieldProps) => {
  const [open, setOpen] = useState(false);

  const day = receiptLocalStringToDay(value);
  const time = receiptLocalStringToTime(value);

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
            disabled={{ after: receiptToday() }}
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
