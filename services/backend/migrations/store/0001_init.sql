-- Template for one user's content store. Applied inside a schema named
-- store_<20 hex characters>, so every statement here is unqualified and every
-- query at runtime runs with `SET LOCAL search_path TO "<schema>", public`.
--
-- Timestamps are timestamptz and are serialised by the API as epoch
-- milliseconds, matching the desktop's own types.

CREATE TABLE IF NOT EXISTS projects (
    id          text PRIMARY KEY,
    name        text NOT NULL,
    path        text NOT NULL DEFAULT '',
    source      text NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'ssh')),
    host        text,
    oven_id     text,
    provider_id text NOT NULL DEFAULT '',
    workflow_id text NOT NULL DEFAULT '',
    icon        text,
    color       text,
    icon_type   text,
    custom_svg  text,
    pinned      boolean NOT NULL DEFAULT false,
    hidden      boolean NOT NULL DEFAULT false,
    sort_order  integer,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS threads (
    id                   text PRIMARY KEY,
    project_id           text NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    title                text NOT NULL,
    status               text NOT NULL DEFAULT 'created',
    read                 boolean NOT NULL DEFAULT false,
    pinned               boolean NOT NULL DEFAULT false,
    archived             boolean NOT NULL DEFAULT false,
    drafting             boolean NOT NULL DEFAULT false,
    last_error           text,
    last_message_preview text,
    message_count        integer NOT NULL DEFAULT 0,
    last_activity        timestamptz NOT NULL DEFAULT now(),
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT threads_status_check CHECK (
        status IN (
            'created',
            'planning',
            'awaiting_approval',
            'spec',
            'executing',
            'working-paused',
            'interrupted',
            'completed',
            'failed'
        )
    )
);

CREATE INDEX IF NOT EXISTS threads_project_idx ON threads (project_id);
CREATE INDEX IF NOT EXISTS threads_activity_idx ON threads (last_activity DESC);

CREATE TABLE IF NOT EXISTS messages (
    id         text PRIMARY KEY,
    thread_id  text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    role       text NOT NULL CHECK (role IN ('user', 'assistant')),
    body       text NOT NULL,
    seq        integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT messages_thread_seq_key UNIQUE (thread_id, seq)
);

CREATE TABLE IF NOT EXISTS prompts (
    id         text PRIMARY KEY,
    thread_id  text NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
    body       text NOT NULL,
    state      text NOT NULL DEFAULT 'queued',
    error      text,
    client_id  text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prompts_thread_idx ON prompts (thread_id);
CREATE UNIQUE INDEX IF NOT EXISTS prompts_thread_client_idx
    ON prompts (thread_id, client_id)
    WHERE client_id IS NOT NULL;
