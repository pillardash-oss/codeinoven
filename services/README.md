# Services

The hosted side of CodeInOven lives here, in the same repository as the desktop app so one change
can touch the client and the server that serves it.

| Service | Stack | Development URL | Purpose |
| --- | --- | --- | --- |
| `services/backend` | Go, `net/http`, Postgres | http://127.0.0.1:8080 | Identity, devices, per-user content store, prompts |
| `services/mobile` | SvelteKit SPA, Capacitor 8 | http://127.0.0.1:5174 | The iOS and Android client |

The desktop app stays a client. It holds no backend code, no Postgres credentials and no provider
secrets; when it needs something from the server it goes through one typed client module.

The plan these two implement, including what is deliberately out of scope, is
`docs/HOSTED-SERVICES.md`. The API below is the contract both services are written against, and the
mobile client is the first consumer, so the shapes are camelCase and match the desktop's own type
names.

## Ports and origins

| Thing | Value |
| --- | --- |
| Backend | `127.0.0.1:8080` (`HTTP_ADDR`) |
| Mobile dev server | `127.0.0.1:5174` |
| Native app origin (iOS) | `capacitor://localhost` |
| Native app origin (Android) | `http://localhost` |
| API base for the app | `PUBLIC_API_BASE`, default `http://127.0.0.1:8080` |

The mobile dev server proxies `/api/*` to the backend, so the browser build and the native build use
the same relative paths. The app reads `PUBLIC_API_BASE` and calls `${base}/v1/...`.

## Running

```sh
# one time: create the local database
bun run services:db:setup

# terminal 1
bun run services:backend:dev

# terminal 2
bun run services:mobile:dev
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

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/health` | `{"status":"ok"}`, no database check |
| `GET` | `/ready` | `200` when Postgres answers, `503` with `{"data":{"database":"down"}}` when it does not |

### Identity

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `POST` | `/v1/auth/email/sign-up` | `{email,password,name,device?}` | `201`, returns `{user,token,device}` |
| `POST` | `/v1/auth/email/sign-in` | `{email,password,device?}` | returns `{user,token,device}` |
| `POST` | `/v1/auth/email/verify` | `{token}` | single use, 24 hours |
| `POST` | `/v1/auth/email/resend` | `{email}` | always `202`, never reveals whether the address exists |
| `POST` | `/v1/auth/email/reset/request` | `{email}` | always `202` |
| `POST` | `/v1/auth/email/reset/confirm` | `{token,password}` | revokes every session on use |
| `GET` | `/v1/auth/{provider}/start` | none | `302` to the provider, or `501` when that provider is not configured |
| `GET` | `/v1/auth/{provider}/callback` | none | sets the session, then `302` to `mobile` or `desktop` handoff |
| `POST` | `/v1/auth/sign-out` | none | revokes the current session, `204` |
| `GET` | `/v1/auth/sessions` | none | the caller's sessions, current one marked |
| `DELETE` | `/v1/auth/sessions/{id}` | none | revokes one of the caller's sessions, `204` |

`device` is `{name, platform}` with `platform` one of `desktop`, `ios`, `android`. The backend
records it and returns the device row, which the client keeps for later revocation.

### Account

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/me` | `{id,email,name,avatarUrl,emailVerifiedAt,createdAt,store}` |
| `PATCH` | `/v1/me` | `{name}` |
| `GET` | `/v1/me/devices` | every device, current one marked |
| `DELETE` | `/v1/me/devices/{id}` | revokes that device's sessions, `204` |

### Content

Content lives in the user's own store schema, so every query is scoped by the session's user before
it runs.

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/v1/projects` | `sort=activity\|name\|created`, `q`, `limit`, `cursor` |
| `GET` | `/v1/projects/{id}` | one project with its status counts |
| `GET` | `/v1/threads` | `project`, `state`, `unread=true`, `q`, `limit`, `cursor` |
| `GET` | `/v1/threads/{id}` | one thread |
| `GET` | `/v1/threads/{id}/messages` | oldest first, `limit`, `cursor` |
| `POST` | `/v1/threads/{id}/prompts` | `{body,clientId}`, queues a prompt for an Oven, `202` |
| `GET` | `/v1/prompts/{id}` | `{id,threadId,body,state,createdAt,updatedAt,error?}` |

`limit` defaults to 50 and is capped at 200. `cursor` is opaque; a caller echoes `nextCursor` and
never parses one.

### Presence and store

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/ovens/heartbeat` | `{name,fingerprint,descriptor}`, upserts this user's Oven |
| `GET` | `/v1/ovens` | the user's Ovens with `lastHeartbeatAt` |
| `GET` | `/v1/store/status` | `{kind,schemaVersion,requiredVersion,migratable}` |

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
}
```

All timestamps are epoch milliseconds, matching the desktop's own types so a mirrored row needs no
conversion.

## Environment

The backend reads configuration from the environment only. `.env.example` in `services/backend`
lists every variable; a missing OAuth provider pair disables that provider instead of failing the
service, and a missing mail sender logs verification links in development and refuses to start in
production.

| Variable | Purpose |
| --- | --- |
| `HTTP_ADDR` | Listen address, default `127.0.0.1:8080` |
| `DATABASE_URL` | Postgres connection string |
| `PUBLIC_BASE_URL` | The backend's own origin, used to build callback and verification links |
| `APP_ORIGINS` | Comma separated allowed browser origins for CORS |
| `SESSION_TTL` | Session lifetime, default `720h` |
| `ENVIRONMENT` | `development` or `production` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Enables Google sign-in |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Enables GitHub sign-in |

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
