-- Ledger metadata for a closed period.
--
-- New movement kinds must be committed before any later migration uses them.
-- This file only adds the value. closed_period is used by
-- 20261108090000_replay_checkpoint.sql after this file has committed.
alter type app.movement_type
add value 'closed_period';
