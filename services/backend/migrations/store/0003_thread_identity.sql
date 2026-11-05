-- A thread runs on one harness with one model, and the phone's composer shows
-- that identity before a message is sent: it is the same pair the desktop header
-- reads from its own thread row.
--
-- Both columns are nullable. A thread that has not started a run yet, or one
-- that was mirrored before this migration, has no identity to report, and an
-- absent key is a truer answer than a guessed default. ALTER ... IF NOT EXISTS
-- keeps the statement idempotent, like every other statement in this template.
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS harness text;
