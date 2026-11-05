# CodeInOven backend

The hosted side of CodeInOven: identity, devices, sessions, presence, and the
per-user content store the mobile app reads. Go, `net/http`, Postgres. The API
contract lives in [`../README.md`](../README.md) and this service implements it.

```
cmd/server        wiring only: config -> pool -> migrations -> router -> shutdown
cmd/seed          demo account and demo content
internal/config   environment only, no .env loader
internal/logging  slog JSON handler, level from ENVIRONMENT
internal/auth     argon2id, opaque tokens, id generation, in-memory rate limiter
internal/mail     Sender interface; the only implementation logs links (development)
internal/store    every SQL statement, one schema per user
internal/models   the static model catalog the picker draws
internal/httpapi  envelopes, middleware, route handlers
migrations/       embedded SQL: control plane and the per-user store template
scripts/          db-setup.sh
```

## Setup

Requires Go 1.27 and Postgres 18 (any recent version works).

```sh
bash scripts/db-setup.sh       # creates codeinoven_dev when missing, idempotent
bun run dev                    # or: go run ./cmd/server
bun run seed                   # demo account + content
```

The server applies migrations at startup: the control plane in `public`, then
every provisioned user store. A new store schema is created at sign-up and has
the store template applied to it.

`bun run` scripts: `dev`, `build`, `check` (`go vet`), `test` (`go test`),
`seed`, `db:setup`. bun orchestrates; Go owns the module.

## Environment

Every value comes from the process environment. `.env.example` lists them all.

| Variable | Default | Purpose |
| --- | --- | --- |
| `HTTP_ADDR` | `127.0.0.1:8080` | listen address |
| `DATABASE_URL` | `postgres://localhost:5432/codeinoven_dev?sslmode=disable` | Postgres |
| `PUBLIC_BASE_URL` | `http://127.0.0.1:8080` | this service's own origin: OAuth redirects and mail links |
| `APP_ORIGINS` | empty | extra CORS origins; `capacitor://localhost`, `http://localhost`, `http://127.0.0.1:5174` are always allowed |
| `SESSION_TTL` | `720h` | session lifetime |
| `SESSION_SECRET` | development default | HMAC key for OAuth state cookies; 32+ characters required outside development |
| `ENVIRONMENT` | `development` | log level, cookie `Secure`, mail sender choice |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | empty | enables Google sign-in |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | empty | enables GitHub sign-in |
| `SEED_PASSWORD` | `oven-mobile-demo-pass` | `cmd/seed` only |

Startup is refused, with the reason printed, when:

- a migration file no longer matches the checksum recorded in `schema_migrations`;
- `ENVIRONMENT` is not `development` and `SESSION_SECRET` is missing or short;
- `ENVIRONMENT` is not `development`, because no real mail sender exists yet
  (`internal/mail` logs links in development and nothing else is wired).

## Data model

Control plane, `public` schema:

- `users` – email unique on `lower(email)`, `password_hash` nullable (OAuth-only
  accounts), `email_verified_at`, `deleted_at`
- `accounts` – provider identity links, unique on `(provider, provider_account_id)`
- `devices` – `platform` is `desktop|ios|android`
- `sessions` – `token_hash bytea` (SHA-256 of the token, never the token),
  `user_agent`, `expires_at`, `revoked_at`
- `email_tokens` – single-use `verify` (24h) and `reset` (30m) tokens
- `stores` – one row per user: `schema_name`, `schema_version`
- `ovens` – presence, unique on `(user_id, fingerprint)`

Per-user store, one schema per user named `store_` plus 20 lower case hex
characters: `projects`, `threads`, `messages`, `prompts`, `attachments`, and that
schema's own `schema_migrations`. Every content query runs in a transaction that
first runs

```sql
SET LOCAL search_path TO "<schema>", public
```

and the schema name is validated against `^store_[a-f0-9]{20}$` before it is ever
quoted into SQL. The pool pins control-plane queries to `public` and executes
statements without pgx's statement cache, because a cached plan keyed by SQL text
would bind to the wrong schema.

All timestamps are `timestamptz` in the database and epoch milliseconds in JSON.

Composer columns, added by store migration `0004`, are nullable except the switch:
`threads.thinking`, `threads.permission`, `threads.account`, `threads.oven_id`,
`threads.context_window`, `threads.usage_reset_at`, and `threads.file_system`
(`NOT NULL DEFAULT false`); the same six choices on `prompts` so a queued prompt
states what the phone chose; `messages.input_tokens`, `output_tokens`,
`duration_ms`, `cost_micros`; and `attachments` (bytes plus name/mime/size,
`prompt_id` null until a prompt carries the file). The migration is idempotent
`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and needs no data migration, because
`MigrateAllStores` applies it to every existing store on restart.

## Endpoints implemented

Every response is `{"data": ...}`, paginated lists add `nextCursor` (absent on the
last page), failures are `{"error":{"code","message","details?"}}`.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{"status":"ok"}`, no database access |
| `GET` | `/ready` | `200` with `{"data":{"database":"up"}}`, `503` when Postgres is down |
| `POST` | `/v1/auth/email/sign-up` | `201` `{user,token,device}`; also provisions the store |
| `POST` | `/v1/auth/email/sign-in` | `200` `{user,token,device}`; reuses the device row with the same name+platform |
| `POST` | `/v1/auth/email/verify` | `{token}`, single use, 24h; returns the user |
| `GET` | `/v1/auth/email/verify` | HTML page the development verification link opens |
| `POST` | `/v1/auth/email/resend` | always `202` `{"data":{"sent":true}}` |
| `POST` | `/v1/auth/email/reset/request` | always `202` `{"data":{"sent":true}}` |
| `POST` | `/v1/auth/email/reset/confirm` | `{token,password}`, revokes every session, `{"data":{"reset":true}}` |
| `GET` | `/v1/auth/{google\|github}/start` | `302` to the provider, or `501 unsupported` when that pair is absent |
| `GET` | `/v1/auth/{google\|github}/callback` | exchanges the code, links the account, sets the cookie, `302` to `/v1/auth/oauth/done` |
| `GET` | `/v1/auth/oauth/done` | result page on `PUBLIC_BASE_URL`; no token in any redirect |
| `POST` | `/v1/auth/sign-out` | `204`, revokes the current session |
| `GET` | `/v1/auth/sessions` | `[{id,deviceId,deviceName,platform,createdAt,lastUsedAt,expiresAt,current}]` |
| `DELETE` | `/v1/auth/sessions/{id}` | `204` |
| `GET` | `/v1/me` | user + `store` status |
| `PATCH` | `/v1/me` | `{name}`, sends `null` to clear it; returns the `/v1/me` payload |
| `GET` | `/v1/me/devices` | live devices only, current one marked |
| `DELETE` | `/v1/me/devices/{id}` | `204`, revokes the device and its sessions |
| `GET` | `/v1/projects` | `sort=activity\|name\|created`, `q`, `limit`, `cursor` |
| `GET` | `/v1/projects/{id}` | one project with thread rollup |
| `GET` | `/v1/models` | `{items,recent}`: the static catalog, plus up to 5 ids this account used in the last 30 days |
| `GET` | `/v1/threads` | `project`, `state`, `unread=true`, `q`, `limit`, `cursor` |
| `GET` | `/v1/threads/{id}` | one thread |
| `PATCH` | `/v1/threads/{id}` | `{model?,thinking?,permission?,account?,ovenId?,fileSystem?}`; omitted leaves, `null` clears |
| `GET` | `/v1/threads/{id}/messages` | oldest first, `limit`, `cursor` |
| `GET` | `/v1/threads/{id}/usage` | `{used,window,leftBeforeCompact,thisTurn,rate,costMicros,since}`, derived from token columns |
| `POST` | `/v1/threads/{id}/usage/reset` | `usage_reset_at = now()`, `200` with the meter |
| `POST` | `/v1/threads/{id}/attachments` | `{name,mime,dataBase64}`, `201`, decoded at most 4 MiB |
| `GET` | `/v1/attachments/{id}` | the bytes with their MIME type and length; no JSON envelope |
| `DELETE` | `/v1/attachments/{id}` | `204` while no prompt carries it, `409` once one does |
| `POST` | `/v1/threads/{id}/prompts` | `{body,clientId,attachmentIds?,model?,thinking?,permission?,account?,ovenId?,fileSystem?}`, `202`; omitted choices come from the thread |
| `GET` | `/v1/prompts/{id}` | the prompt with its composer choices and `attachments` (always a list) |
| `DELETE` | `/v1/prompts/{id}` | `204` for a still-`queued` prompt, `409` once an Oven claimed it |
| `POST` | `/v1/prompts/{id}/steer` | the Oven takes this prompt next; state becomes `steering` |
| `POST` | `/v1/ovens/heartbeat` | `{name,fingerprint,descriptor}`, upserts on the fingerprint |
| `GET` | `/v1/ovens` | the user's Ovens with `lastHeartbeatAt` |
| `GET` | `/v1/store/status` | `{kind,schemaVersion,requiredVersion,migratable}` |

`limit` defaults to 50 and is capped at 200. Cursors are opaque base64url and are
bound to the ordering that produced them: replaying a project cursor against a
different `sort`, or a thread cursor against messages, answers `400 bad_request`.

`PATCH /v1/threads/{id}` is a patch, not a whole thread: an absent key keeps the
column, an explicit `null` clears it, and a value sets it. `thinking`,
`permission`, `model` and `ovenId` are validated against the enums, the catalog and
the caller's Ovens, so an unknown value is `400 bad_request` and an unknown thread
is `404`.

`state` on `/v1/threads` accepts one exact status (`created`, `planning`,
`awaiting_approval`, `spec`, `executing`, `working-paused`, `interrupted`,
`completed`, `failed`) or one of the project rollup groups:
| Group | Statuses |
| --- | --- |
| `attention` | created, planning, awaiting_approval, interrupted |
| `spec` | spec |
| `working` | executing, working-paused |
| `done` | completed |
| `failed` | failed |

### Auth mechanics

Sessions are opaque: 32 random bytes, base64url, returned as `cio_<43 chars>`, and
only the SHA-256 of that string is stored. The bearer header is read first, then
the `cio_session` cookie (`HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` unless
`ENVIRONMENT=development`). `last_used_at` and the device's `last_seen_at` are
refreshed at most once a minute per session.

Passwords: argon2id, m=65536 KiB, t=3, p=2, 16 byte salt, 32 byte key, parameters
inside the PHC string, constant-time compare. 12 to 128 characters, no
composition rules.

Rate limiting: in-memory fixed window of 10 attempts per 15 minutes, charged per
IP and per email on sign-up, sign-in, resend, and reset request. `429
rate_limited` when either key is exhausted. A restart clears the counters.

## Deliberate deviations from the contract's letters

1. **Sign-up issues a session immediately, and signing in unverified works.**
   There is no mail provider, so requiring verification before a session or a
   device would lock every new account out. Users are created with
   `emailVerifiedAt: null`, the verification link is logged in development, and
   `email_not_verified` exists in the error table but v1 never returns it.
2. **No OAuth token handoff.** The callback sets the cookie and redirects to
   `/v1/auth/oauth/done` on this service's own origin. There is no single-use
   handoff code, loopback callback, or deep link, so a native app cannot finish
   OAuth against this service yet; the browser flow is what works. Without
   credentials `/v1/auth/{provider}/start` answers `501 unsupported`, as
   specified.
3. **Store versions are integers.** `schemaVersion` and `requiredVersion` are the
   number of store migrations applied and required. `migratable` is
   informational: the server migrates every store at startup, so a store is
   normally already current. There is no `POST .../store/migrate` endpoint.
4. **Endpoints the contract leaves open** return the smallest honest payload:
   verify/reset-confirm/resend as shown in the table above, plus `/v1/me` and the
   `PATCH` response carrying the full `me` payload.
5. **`/v1/me/devices` hides revoked devices** (the `Device` payload has no
   `revokedAt`), so a deleted device disappears from the list.
6. **Hidden projects are returned** with `hidden: true`; filtering is the client's
   decision.
7. **A known path with the wrong method answers `404`** in the contract's
   envelope rather than Go's default `405` text.
8. **`X-Forwarded-For` is not trusted** for rate-limit keys; the peer address is
   used, which is correct for a single process and wrong behind a proxy that does
   not preserve peer addresses.
9. **OAuth links accounts by verified email.** A provider email is trusted only
   when the provider marks it verified, which is what allows linking a Google or
   GitHub sign-in to an existing password account.
10. **Threads and projects are read-only here**, with one exception: the composer's
    choices (`PATCH /v1/threads/{id}`) and the usage reset are writable, because
    the phone owns those chips. Prompts are the only content write besides those,
    and messages arrive with the sync endpoints listed below.
11. **Only the attachment upload route allows a 6 MiB body.** A 4 MiB file is
    about 5.6 MB of base64, so the 1 MiB default would reject every phone photo;
    every other route keeps that default. `decodeJSON` still caps at 1 MiB, so the
    upload path carries its own matching decoder.

## Seeding

`go run ./cmd/seed` (or `bun run seed`) ensures `demo@codeinoven.local`, verifies
it, sets the password from `SEED_PASSWORD`, provisions its store, then truncates
that user's content and rewrites it in one transaction. Re-running is safe and
leaves the same row counts: 6 projects, 126 threads covering all nine statuses
(some unread, some pinned), and a message trail for every thread with three full
conversations. It logs the account email and the number of rows written.

Every demo thread carries the composer's choices: a catalog model id and harness,
a thinking level, a permission, an account label, the File System switch, and a
`contextWindow` of 128000, so the header and the meter are populated without the
phone writing anything first. Assistant messages carry deterministic token counts,
a duration and a cost, so the usage panel shows real numbers after a seed. Thread
identities are checked against `internal/models` before anything is written, so a
catalog rename fails the seed instead of leaving threads that name a model nothing
can run.

Demo projects: `codeinoven` (89 threads, `codeinoven.png`),
`inside-edge-classroom`, `rallip` (an `ssh` project), `milogs`, `printwyze`,
`shiloh`.

## Not built yet

- Sync push/pull: no endpoint writes projects, threads, or messages from a
  device, and there is no outbox/conflict model on the server.
- A store migration endpoint beyond `GET /v1/store/status`.
- Push notifications, and the device token storage they need.
- A real mail provider: verification and reset links only reach the development
  log.
- Token handoff for the native/desktop OAuth flows (see deviation 2).
- Password change for a signed-in user (reset by email is the only path),
  account deletion, and session cleanup for expired rows.
- Persistent rate limiting across processes.

## Tests

```sh
go test ./...        # or bun run test
go vet ./...         # or bun run check
```

Unit tests cover argon2id hashing and its policy, token shape and SHA-256 hashing,
id generation, the rate limiter (window, independence, shared budget), cursor
encode/decode (round trip, wrong ordering, garbage), the error-code to status map,
envelope shapes, JSON decoding limits, `state` parsing, schema-name validation and
`LIKE` escaping. Store queries and HTTP handlers are exercised against a live
Postgres with curl rather than an in-process fake.
