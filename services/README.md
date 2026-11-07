# Services

The hosted side of CodeInOven lives here, in the same repository as the desktop app so one change
can touch the client and the server that serves it.

| Service            | Stack                      | Development URL       | Purpose                                            |
| ------------------ | -------------------------- | --------------------- | -------------------------------------------------- |
| `services/backend` | Go, `net/http`, Postgres   | http://127.0.0.1:8080 | Identity, devices, per-user content store, prompts |
| `services/mobile`  | SvelteKit SPA, Capacitor 8 | http://127.0.0.1:5174 | The iOS and Android client                         |

The desktop app stays a client. It holds no backend code, no Postgres credentials and no provider
secrets; when it needs something from the server it goes through one typed client module.

The plan these two implement, including what is deliberately out of scope, is
`docs/HOSTED-SERVICES.md`. The API below is the contract both services are written against, and the
mobile client is the first consumer, so the shapes are camelCase and match the desktop's own type
names.

## Ports and origins

| Thing                       | Value                                              |
| --------------------------- | -------------------------------------------------- |
| Backend                     | `127.0.0.1:8080` (`HTTP_ADDR`)                     |
| Mobile dev server           | `127.0.0.1:5174`                                   |
| Native app origin (iOS)     | `capacitor://localhost`                            |
| Native app origin (Android) | `http://localhost`                                 |
| API base for the app        | `PUBLIC_API_BASE`, default `http://127.0.0.1:8080` |

The mobile dev server proxies `/api/*` to the backend, so the browser build and the native build use
the same relative paths. The app reads `PUBLIC_API_BASE` and calls `${base}/v1/...`.

## Running

Development has two separate states on purpose, so a phone testing a build can
never touch the desktop's data or a deployed instance:

| State               | Port | Database                | Used by                           |
| ------------------- | ---- | ----------------------- | --------------------------------- |
| Desktop development | 8080 | `codeinoven_dev`        | the desktop app and the browser   |
| Mobile development  | 8081 | `codeinoven_mobile_dev` | the emulator and a physical phone |

```sh
# one time: create both databases
bun run services:db:setup
bun run services:mobile:db:setup

# desktop development
bun run services:backend:dev
bun run services:mobile:dev

# mobile development (separate database, separate port)
bun run services:backend:dev:mobile
bun run services:backend:seed:mobile
```

The mobile app talks to the mobile backend at `http://localhost:8081`, which the
emulator reaches through `adb reverse tcp:8081 tcp:8081`. Using `localhost` rather
than the host alias keeps the OAuth redirect URI Google and GitHub accept
registerable (`http://localhost:8081/...`). A physical phone on the same network
uses the host's LAN address instead, and that address must also be registered.

```sh
adb reverse tcp:8081 tcp:8081
cd services/mobile && VITE_API_BASE=http://localhost:8081 bun run build
bun run services:mobile:android
adb install -r services/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

`services:db:setup` creates `codeinoven_dev` if it is missing. The server applies migrations at
startup, so a schema change lands by restarting it. `bun run services:backend:seed` writes a demo
account and the content the mobile app shows on first run.

## Response envelope

Every successful response carries its payload under `data`. A paginated list adds `nextCursor`,
which is absent on the last page.

```json
{ "data": { "id": "th_01H..." } }
{ "data": [{ "id": "th_01H..." }], "nextCursor": "eyJsYSI6MTc2..." }
```

Every failure uses one shape, with an HTTP status that matches the code:

```json
{ "error": { "code": "invalid_credentials", "message": "Email or password is incorrect." } }
```

Codes in use: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`,
`invalid_credentials`, `email_not_verified`, `rate_limited`, `unsupported`, `internal`.

## Authentication

Sessions are opaque tokens, never JWTs. The token is returned once; the database stores only its
SHA-256 hash.

```
Authorization: Bearer cio_<43 base64url characters>
```

A browser build may alternatively carry the token in the `cio_session` cookie, which the backend
sets `HttpOnly`, `SameSite=Lax`, and `Secure` outside development. The mobile app keeps the token in
the device keychain and sends the bearer header, because a Capacitor WebView's cookie jar is not a
durable store.

Requests without a valid session answer `401 unauthorized`. A session that expired or was revoked
answers `401` with code `unauthorized` and no detail about which device it belonged to.

## Endpoints

### Health

| Method | Path      | Notes                                                                                   |
| ------ | --------- | --------------------------------------------------------------------------------------- |
| `GET`  | `/health` | `{"status":"ok"}`, no database check                                                    |
| `GET`  | `/ready`  | `200` when Postgres answers, `503` with `{"data":{"database":"down"}}` when it does not |

### Identity

| Method   | Path                           | Body                            | Notes                                                                |
| -------- | ------------------------------ | ------------------------------- | -------------------------------------------------------------------- |
| `POST`   | `/v1/auth/email/sign-up`       | `{email,password,name,device?}` | `201`, returns `{user,token,device}`                                 |
| `POST`   | `/v1/auth/email/sign-in`       | `{email,password,device?}`      | returns `{user,token,device}`                                        |
| `POST`   | `/v1/auth/email/verify`        | `{token}`                       | single use, 24 hours                                                 |
| `POST`   | `/v1/auth/email/resend`        | `{email}`                       | always `202`, never reveals whether the address exists               |
| `POST`   | `/v1/auth/email/reset/request` | `{email}`                       | always `202`                                                         |
| `POST`   | `/v1/auth/email/reset/confirm` | `{token,password}`              | revokes every session on use                                         |
| `GET`    | `/v1/auth/{provider}/start`    | none                            | `302` to the provider, or `501` when that provider is not configured |
| `GET`    | `/v1/auth/{provider}/callback` | none                            | sets the session, then `302` to `mobile` or `desktop` handoff        |
| `POST`   | `/v1/auth/sign-out`            | none                            | revokes the current session, `204`                                   |
| `GET`    | `/v1/auth/sessions`            | none                            | the caller's sessions, current one marked                            |
| `DELETE` | `/v1/auth/sessions/{id}`       | none                            | revokes one of the caller's sessions, `204`                          |

`device` is `{name, platform}` with `platform` one of `desktop`, `ios`, `android`. The backend
records it and returns the device row, which the client keeps for later revocation.

### Account

| Method   | Path                  | Notes                                                       |
| -------- | --------------------- | ----------------------------------------------------------- |
| `GET`    | `/v1/me`              | `{id,email,name,avatarUrl,emailVerifiedAt,createdAt,store}` |
| `PATCH`  | `/v1/me`              | `{name}`                                                    |
| `GET`    | `/v1/me/devices`      | every device, current one marked                            |
| `DELETE` | `/v1/me/devices/{id}` | revokes that device's sessions, `204`                       |

### Content

Content lives in the user's own store schema, so every query is scoped by the session's user before
it runs.

| Method   | Path                        | Notes                                                                    |
| -------- | --------------------------- | ------------------------------------------------------------------------ |
| `GET`    | `/v1/projects`              | `sort=activity\|name\|created`, `q`, `limit`, `cursor`                   |
| `GET`    | `/v1/projects/{id}`         | one project with its status counts                                       |
| `GET`    | `/v1/models`                | `{items,recent}`: the catalog plus up to 5 recently used ids              |
| `GET`    | `/v1/threads`               | `project`, `state`, `unread=true`, `q`, `limit`, `cursor`                |
| `GET`    | `/v1/threads/{id}`          | one thread                                                               |
| `PATCH`  | `/v1/threads/{id}`          | the composer's choices; omitted leaves, `null` clears, `200` with thread  |
| `GET`    | `/v1/threads/{id}/messages` | oldest first, `limit`, `cursor`                                          |
| `GET`    | `/v1/threads/{id}/usage`    | the context meter, derived from stored token columns                      |
| `POST`   | `/v1/threads/{id}/usage/reset` | `usage_reset_at = now()`, `200` with `Usage`                           |
| `POST`   | `/v1/threads/{id}/attachments` | `{name,mime,dataBase64}`, `201` `Attachment`, decoded at most 4 MiB    |
| `GET`    | `/v1/attachments/{id}`      | the bytes with their own `Content-Type`: never JSON                       |
| `DELETE` | `/v1/attachments/{id}`      | `204` while no prompt carries it, `409` once one does                     |
| `POST`   | `/v1/threads/{id}/prompts`  | `{body,clientId?,attachmentIds?,model?,thinking?,permission?,account?,ovenId?,fileSystem?}`, `202` |
| `GET`    | `/v1/prompts/{id}`          | `{id,threadId,body,state,createdAt,updatedAt,error?,model,thinking,permission,account,ovenId,fileSystem,attachments}` |
| `DELETE` | `/v1/prompts/{id}`          | takes back a prompt still `queued`, `204`; `409` once an Oven claimed it |
| `POST`   | `/v1/prompts/{id}/steer`    | the Oven takes this prompt next; state becomes `steering`                |

A prompt is the person's until an Oven claims it. `queued` is the only state a caller may delete or
steer; past that the service answers `409`, so a held message is never silently rewritten under a
running turn.

`limit` defaults to 50 and is capped at 200. `cursor` is opaque; a caller echoes `nextCursor` and
never parses one.

### The composer's choices

The phone's composer is the desktop's, so the choices it makes travel with the thread and with every
prompt. On `PATCH /v1/threads/{id}` a key that is **absent** leaves the column alone, an explicit
**`null`** clears it, and a value sets it. `thinking` is one of `minimal`, `low`, `medium`, `high`,
`xhigh`, `max`, `ultra`; `permission` is `auto_review` or `full_access`; `model` is one of the ids
`GET /v1/models` lists; `ovenId` names one of this account's Ovens; `account` is at most 120
characters; `fileSystem` is a boolean. Any other value is `400 bad_request`, and an unknown thread is
`404`.

`POST /v1/threads/{id}/prompts` accepts the same fields: what it omits is read from the thread row at
queue time, so the stored prompt always states the full choice the desktop will run. `attachmentIds`
must be this thread's unattached attachments; an id that is unknown, from another thread, or already
carried by a prompt is a `400`.

### Attachments and the meter

Files travel as base64 inside JSON, because that is what a WebView can send without a multipart
encoder. The upload route is the only one with a 6 MiB body limit; every other route keeps 1 MiB. A
decoded file may weigh at most 4 MiB, its `name` and `mime` must be non-empty, and the download route
answers with the file itself rather than the JSON envelope.

`Usage` is derived from stored token columns and nothing else:

- `used` – sum of `inputTokens + outputTokens` over this thread's messages created after
  `usageResetAt`, all of them when it is null.
- `window` – `contextWindow`; `leftBeforeCompact` is `max(window - used, 0)`.
- `thisTurn` – the latest assistant message's token counts, `0` when it has none.
- `rate` – the latest assistant `outputTokens / (durationMs / 1000)`, `0` without it.
- `costMicros` – the latest assistant message's `costMicros`, `0` without it.
- `since` – `usageResetAt` in epoch milliseconds, `null` when never reset.

A run that reported nothing leaves those columns null, and the meter reads null as `0` rather than
guessing.

### Presence and store

| Method | Path                  | Notes                                                     |
| ------ | --------------------- | --------------------------------------------------------- |
| `POST` | `/v1/ovens/heartbeat` | `{name,fingerprint,descriptor}`, upserts this user's Oven |
| `GET`  | `/v1/ovens`           | the user's Ovens with `lastHeartbeatAt`                   |
| `GET`  | `/v1/store/status`    | `{kind,schemaVersion,requiredVersion,migratable}`         |

## Payload shapes

These are the exact names the mobile client's `src/lib/api/types.ts` declares.

```ts
type ThreadStatus =
  | 'created'
  | 'planning'
  | 'awaiting_approval'
  | 'spec'
  | 'executing'
  | 'working-paused'
  | 'interrupted'
  | 'completed'
  | 'failed'

interface User {
  id: string
  email: string
  name: string | null
  avatarUrl: string | null
  emailVerifiedAt: number | null
  createdAt: number
}

interface Device {
  id: string
  name: string
  platform: 'desktop' | 'ios' | 'android'
  lastSeenAt: number
  createdAt: number
  current: boolean
}

interface Project {
  id: string
  name: string
  path: string
  source: 'local' | 'ssh'
  host: string | null
  ovenId: string | null
  providerId: string
  workflowId: string
  icon: string | null
  color: string | null
  iconType: string | null
  customSvg: string | null
  pinned: boolean
  hidden: boolean
  sortOrder: number | null
  threadCount: number
  unreadCount: number
  statusCounts: {
    attention: number
    spec: number
    working: number
    done: number
    failed: number
  }
  createdAt: number
  updatedAt: number
}

interface Thread {
  id: string
  projectId: string
  title: string
  status: ThreadStatus
  read: boolean
  pinned: boolean
  archived: boolean
  drafting: boolean
  model: string | null
  harness: string | null
  thinking: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra' | null
  permission: 'auto_review' | 'full_access' | null
  account: string | null
  ovenId: string | null
  fileSystem: boolean
  contextWindow: number | null
  usageResetAt: number | null
  lastError: string | null
  messageCount: number
  lastMessagePreview: string | null
  lastActivity: number
  createdAt: number
  updatedAt: number
}

interface Message {
  id: string
  threadId: string
  role: 'user' | 'assistant'
  body: string
  seq: number
  createdAt: number
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
  costMicros: number | null
}

interface Attachment {
  id: string
  threadId: string
  promptId: string | null
  name: string
  mime: string
  size: number
  createdAt: number
}

interface Prompt {
  id: string
  threadId: string
  body: string
  state: 'queued' | 'claimed' | 'steering' | 'done' | 'failed'
  error: string | null
  createdAt: number
  updatedAt: number
  model: string | null
  thinking: string | null
  permission: string | null
  account: string | null
  ovenId: string | null
  fileSystem: boolean
  /** Always a list, never null. */
  attachments: Attachment[]
}

interface Model {
  id: string
  name: string
  provider: 'opencode' | 'openai' | 'anthropic' | 'deepseek'
  providerLabel: string
  favorite: boolean
}

interface ModelCatalog {
  items: Model[]
  recent: string[]
}

interface ThreadUsage {
  used: number
  window: number
  leftBeforeCompact: number
  thisTurn: { input: number; output: number }
  rate: number
  costMicros: number
  since: number | null
}
```

All timestamps are epoch milliseconds, matching the desktop's own types so a mirrored row needs no
conversion.

### Model catalog

The catalog is static data in the service, grouped by provider and ordered as the picker draws it.
`id` always starts with the provider slug, so a client resolves its bundled vendor mark from the id
alone:

| Provider    | Models                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `opencode`  | `opencode/beam-free`, `opencode/big-pickle`, `opencode/claude-sonnet-5.5`                                 |
| `openai`    | `openai/gpt-6.1-sol`, `openai/gpt-6-astra`, `openai/gpt-5.6-sol`, `openai/gpt-5.5`                       |
| `anthropic` | `anthropic/claude-opus-5.5`, `anthropic/claude-sonnet-5.5`, `anthropic/claude-haiku-4.5`, `anthropic/opus-5-1m` |
| `deepseek`  | `deepseek/deepseek-v4.1-flash`, `deepseek/deepseek-v4-pro`                                               |

`openai/gpt-6.1-sol` and `deepseek/deepseek-v4.1-flash` are the favourites. `recent` is up to five ids
this account's threads used in the last thirty days, most recently active first, and only ids the
catalog still contains.

## Environment

The backend reads configuration from the environment only. `.env.example` in `services/backend`
lists every variable; a missing OAuth provider pair disables that provider instead of failing the
service, and a missing mail sender logs verification links in development and refuses to start in
production.

| Variable                                   | Purpose                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `HTTP_ADDR`                                | Listen address, default `127.0.0.1:8080`                                |
| `DATABASE_URL`                             | Postgres connection string                                              |
| `PUBLIC_BASE_URL`                          | The backend's own origin, used to build callback and verification links |
| `APP_ORIGINS`                              | Comma separated allowed browser origins for CORS                        |
| `SESSION_TTL`                              | Session lifetime, default `720h`                                        |
| `ENVIRONMENT`                              | `development` or `production`                                           |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enables Google sign-in                                                  |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Enables GitHub sign-in                                                  |

### Provider sign-in and the app handoff

`GET /v1/auth/providers` reports which providers are configured, so a client hides
a button instead of offering a sign-in that cannot finish. The native flow is:

1. the app opens the system browser at
   `/v1/auth/{provider}/start?platform=android&redirect=codeinoven%3A%2F%2Fauth`
2. the callback mints a two-minute, single-use code and redirects to
   `codeinoven://auth?code=...`
3. the app exchanges that code with `POST /v1/auth/oauth/exchange`, and no token
   ever travels through a URL

The redirect target in the state is allowlisted: the app scheme, or a browser
origin already trusted for CORS. Anything else is refused.

Register these callback URLs with each provider:

| Provider                             | Callback URL                                    |
| ------------------------------------ | ----------------------------------------------- |
| Google (GCP Web application client)  | `http://localhost:8081/v1/auth/google/callback` |
| GitHub (OAuth App, not a GitHub App) | `http://localhost:8081/v1/auth/github/callback` |

Credentials live in `services/backend/.env.oauth`, which is gitignored and mode
`0600`. The mobile dev script sources it when it exists:

```sh
set -a; . services/backend/.env.oauth; set +a
```

## Native builds

`services/mobile` is a static SPA. Capacitor wraps the same build for both platforms:

```sh
cd services/mobile
bun run build
bun run native:sync      # copies build/ into ios/ and android/
bun run native:ios       # opens Xcode
bun run native:android   # opens Android Studio
```

The native projects are generated once and committed, because both platforms carry hand edits in
`Info.plist`, `AndroidManifest.xml` and the app icons. Regenerating them discards those edits.
