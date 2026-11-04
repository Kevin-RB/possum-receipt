-- A receipt's transaction datetime becomes the printed wall clock.
--
-- `timestamptz` held an instant that every read converted back with a
-- timezone; the day it fell on therefore depended on who was reading. The
-- column now holds the local date and time printed on the receipt.
--
-- The `USING` clause is deliberate and must not be "tidied" into a bare
-- `::timestamp`: that cast reads the instant in the *session's* timezone
-- (UTC by default), which would shift every existing row by ten hours. The
-- rows were written by interpreting the printed wall clock as Brisbane, so
-- reading them back in Brisbane recovers exactly that wall clock.
ALTER TABLE "receipts"
  ALTER COLUMN "transaction_datetime" TYPE timestamp
  USING "transaction_datetime" AT TIME ZONE 'Australia/Brisbane';
