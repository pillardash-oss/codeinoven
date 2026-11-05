-- The phone's composer is the desktop's, so a thread row has to carry the
-- choices that composer makes: how hard the model thinks, how tool calls are
-- approved, which account a message runs as, which Oven it goes to, whether the
-- File System switch is on, the context the model offers, and when the meter was
-- last reset.
--
-- Every column is nullable except the switch, and the switch defaults to false,
-- because "off" is what a thread that never touched the composer means. A
-- nullable column stays NULL instead of guessing a default: an untouched thread
-- reads as "no choice stated", which is the honest answer and the one the phone
-- renders as a bare chip.
--
-- MigrateAllStores applies this to every existing store schema on restart, so
-- ALTER ... ADD COLUMN IF NOT EXISTS is all that is needed and no data migration
-- runs. The statements are idempotent, like every other migration here.
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS thinking text;
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS permission text;
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS account text;
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS oven_id text;
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS file_system boolean NOT NULL DEFAULT false;
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS context_window integer;
ALTER TABLE IF EXISTS threads ADD COLUMN IF NOT EXISTS usage_reset_at timestamptz;

-- A turn's cost is recorded by the run that produced it. NULL means the run did
-- not report it, which is not the same as zero, so the meter sums what exists and
-- reads absent columns as 0 rather than writing 0 over an unknown.
ALTER TABLE IF EXISTS messages ADD COLUMN IF NOT EXISTS input_tokens integer;
ALTER TABLE IF EXISTS messages ADD COLUMN IF NOT EXISTS output_tokens integer;
ALTER TABLE IF EXISTS messages ADD COLUMN IF NOT EXISTS duration_ms integer;
ALTER TABLE IF EXISTS messages ADD COLUMN IF NOT EXISTS cost_micros integer;

-- A prompt is what the desktop picks up, so it carries the choices itself rather
-- than only the thread's defaults: by the time the Oven reads it, the thread may
-- already have been changed for the next message.
ALTER TABLE IF EXISTS prompts ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE IF EXISTS prompts ADD COLUMN IF NOT EXISTS thinking text;
ALTER TABLE IF EXISTS prompts ADD COLUMN IF NOT EXISTS permission text;
ALTER TABLE IF EXISTS prompts ADD COLUMN IF NOT EXISTS account text;
ALTER TABLE IF EXISTS prompts ADD COLUMN IF NOT EXISTS oven_id text;
ALTER TABLE IF EXISTS prompts ADD COLUMN IF NOT EXISTS file_system boolean NOT NULL DEFAULT false;

-- Attachments hold the bytes of one file the phone sent with a message. They are
-- bound to a prompt once it is queued (prompt_id NULL until then) so an upload
-- that is never sent can be deleted, and a deleted thread or prompt takes its
-- attachments with it.
CREATE TABLE IF NOT EXISTS attachments (
    id         text PRIMARY KEY,
    thread_id  text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    prompt_id  text REFERENCES prompts (id) ON DELETE CASCADE,
    name       text NOT NULL,
    mime       text NOT NULL,
    size       integer NOT NULL,
    bytes      bytea NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_thread_idx ON attachments (thread_id);
CREATE INDEX IF NOT EXISTS attachments_prompt_idx ON attachments (prompt_id);
