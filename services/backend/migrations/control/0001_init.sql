-- Control plane: everything that is about the account rather than its content.
-- Applied to the `public` schema of the service database.

CREATE TABLE IF NOT EXISTS users (
    id                text PRIMARY KEY,
    email             text NOT NULL,
    password_hash     text,
    email_verified_at timestamptz,
    name              text,
    avatar_url        text,
    created_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at        timestamptz
);

-- Addresses are stored lower cased and compared case insensitively.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

CREATE TABLE IF NOT EXISTS accounts (
    id                  text PRIMARY KEY,
    user_id             text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider            text NOT NULL,
    provider_account_id text NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT accounts_provider_account_key UNIQUE (provider, provider_account_id)
);

CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts (user_id);

CREATE TABLE IF NOT EXISTS devices (
    id           text PRIMARY KEY,
    user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name         text NOT NULL,
    platform     text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    revoked_at   timestamptz,
    CONSTRAINT devices_platform_check CHECK (platform IN ('desktop', 'ios', 'android'))
);

CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_id);

CREATE TABLE IF NOT EXISTS sessions (
    id           text PRIMARY KEY,
    user_id      text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id    text NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    token_hash   bytea NOT NULL UNIQUE,
    user_agent   text,
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_device_idx ON sessions (device_id);

CREATE TABLE IF NOT EXISTS email_tokens (
    id         text PRIMARY KEY,
    user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    kind       text NOT NULL,
    token_hash bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT email_tokens_kind_check CHECK (kind IN ('verify', 'reset'))
);

CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens (user_id);

CREATE TABLE IF NOT EXISTS stores (
    id             text PRIMARY KEY,
    user_id        text NOT NULL UNIQUE REFERENCES users (id) ON DELETE CASCADE,
    kind           text NOT NULL DEFAULT 'postgres',
    schema_name    text NOT NULL UNIQUE,
    schema_version integer NOT NULL DEFAULT 0,
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ovens (
    id                text PRIMARY KEY,
    user_id           text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    name              text NOT NULL,
    fingerprint       text NOT NULL,
    last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
    descriptor        jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT ovens_user_fingerprint_key UNIQUE (user_id, fingerprint)
);
