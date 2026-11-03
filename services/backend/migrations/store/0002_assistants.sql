-- Assistants are the scheduled and manual helpers the account owns. The phone
-- lists them read-only: it names one, shows what it does, when it runs, and how
-- much work it has produced. Editing an assistant stays on the desktop.
--
-- The icon is the user's own stored SVG, which is what makes a list of five
-- assistants readable at a glance on a phone.
CREATE TABLE IF NOT EXISTS assistants (
    id            text PRIMARY KEY,
    name          text NOT NULL,
    description   text NOT NULL DEFAULT '',
    schedule_name text,
    color         text,
    custom_svg    text,
    scheduled     boolean NOT NULL DEFAULT false,
    paused        boolean NOT NULL DEFAULT false,
    thread_count  integer NOT NULL DEFAULT 0,
    last_run_at   timestamptz,
    sort_order    integer,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assistants_order ON assistants (sort_order, updated_at DESC);
