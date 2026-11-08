-- Ledger metadata (phase 5, PR 1).
--
-- New movement kinds must be committed before any later migration uses them.
-- This file only adds the values. sale_reversal already exists.
alter type app.movement_type
add value 'waste_reversal';

alter type app.movement_type
add value 'count_compensation';
