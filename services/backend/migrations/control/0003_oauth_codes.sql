-- A native app cannot receive a session cookie from the system browser, so the
-- OAuth callback hands it a one-time code instead and the app trades that code
-- for a session over its own HTTPS request. Only the hash is stored, the code
-- lives for two minutes, and it is consumed once.
CREATE TABLE IF NOT EXISTS oauth_codes (
    id         text PRIMARY KEY,
    user_id    text NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    device_id  text NOT NULL,
    code_hash  bytea NOT NULL UNIQUE,
    expires_at timestamptz NOT NULL,
    used_at    timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_codes_expiry ON oauth_codes (expires_at);
