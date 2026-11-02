# Hosted services: backend and mobile

This is the plan for the hosted side of CodeInOven. It was settled in the former
`codeinoven-cloud` repository and moved here, so the desktop app, the Go service and the mobile
client have one home and one history.

| Decision | Value |
| --- | --- |
| Backend language | Go, in `services/backend`, standard library HTTP |
| Backend database | Postgres |
| Backend dependencies | `pgx` for Postgres, `argon2` for passwords, embedded SQL for migrations |
| Mobile client | A native app built with Capacitor 8, not a PWA |
| Mobile framework | SvelteKit 3, static single page build |
| Mobile storage today | The device's own keychain-backed token, no offline cache yet |
| Mobile look and feel | The CodeInOven brand, the same tokens as the desktop |
| Mobile scope | Chat only. No terminal, no file tree, no spec studio |
| Desktop app's part | A client only. It holds no backend code, no Postgres credentials, no provider secrets |

## 1. What lives where

The desktop app keeps working offline exactly as it does today. Its local SQLite stays the working
copy an agent turn writes to, and nothing about the run path changes. What it gains is an account:
identity, a device record, and one typed client for this service.

| Concern | Lives in | Notes |
| --- | --- | --- |
| Identity, sessions, devices, Oven presence | This repository | One Go service, one Postgres cluster |
| User content (projects, threads, messages, prompts) | This repository, one schema per user | Self hosting can point at the user's own Postgres |
| Agent execution | Never here | Always on an Oven, which is the user's machine |
| Desktop client | The desktop app | IPC domain plus a typed API client, no backend logic |
| Mobile client | `services/mobile` | Capacitor shell around a static SvelteKit build |

## 2. Service shape

`net/http` with a `ServeMux` and method patterns. No HTTP framework and no ORM, because the routing
this service needs is request path patterns and the queries are SQL a reader can check.

```
services/backend/
  cmd/server/            wiring only
  cmd/seed/              the demo account and its content
  internal/httpapi/      handlers, JSON envelope, error mapping, middleware
  internal/auth/         passwords, tokens, ids, rate limits
  internal/store/        control plane queries, user store provisioning, migrations
  migrations/control/    control plane schema
  migrations/store/      the per-user content schema
```

Configuration comes from the environment only. A missing OAuth provider pair disables that provider
rather than failing the service, so the backend runs with email and password alone.

## 3. Identity

- **Sessions** are opaque random tokens, never JWTs, because revocation has to be immediate. The
  token is returned once and only its SHA-256 hash is stored.
- **Transport**: a bearer header for the desktop and the phone, because a native shell has no
  cookie jar it can rely on; an `HttpOnly`, `SameSite=Lax` cookie for the browser.
- **Passwords** use Argon2id with parameters recorded beside the hash so they can be raised later.
  Minimum 12 characters, no composition rules, no maximum below 128.
- **Verification and reset** are single use tokens hashed at rest, 24 hours and 30 minutes. A reset
  revokes every session.
- **Google and GitHub** are OAuth authorizations started from this service, so no client ever holds
  a provider secret. GitHub requests `read:user user:email`; an account links to an existing user by
  a verified address.
- **Rate limits** are per address and per IP on sign-up, sign-in, resend and reset.

One deliberate deviation: sign-up issues a session before the address is verified, and the account
says so. Verification before first use is the stricter rule, and it assumes a transactional mail
sender exists. None is configured yet, so blocking the first launch on delivered mail would make the
mobile app unusable, not safer. The rule comes back when a sender is chosen.

## 4. Data model

Control plane, in `public`: `users`, `accounts`, `sessions`, `devices`, `email_tokens`, `stores`,
`ovens`.

Per-user content, in a schema named `store_<random hex>` provisioned at sign-up: `projects`,
`threads`, `messages`, `prompts`, plus that schema's own `schema_migrations`.

Two rules carried from the desktop research:

- **Secrets never travel.** Vault values, agent secrets, Oven SSH material and MCP credentials stay
  on the device. Only a reference syncs, and a reference arriving on a new device resolves to
  nothing, which is a prompt, not an error.
- **A store credential is different.** A self-hosted Postgres connection string is held by this
  service, encrypted at rest with a key kept outside the database, with a rotation path.

Migrations are forward only, recorded with a checksum, applied at startup, and refused when a
recorded checksum no longer matches the file. A user store is isolated by schema rather than by a
database per user, because a connection and a vacuum job per user do not pay for isolation the
service cannot honestly claim to give.

## 5. API

Versioned under `/v1`, JSON, cursor pagination, and one error shape. The exact endpoints and payload
shapes are in `services/README.md`, which is the contract the client is written against.

| Group | Endpoints |
| --- | --- |
| Health | `/health`, `/ready` |
| Identity | email sign-up, sign-in, verify, resend, reset, OAuth start and callback, sign-out, sessions |
| Account | `/v1/me`, devices, device revocation |
| Content | projects, threads, thread messages, queued prompts |
| Presence | Oven heartbeat and listing, store status |

Two shapes that keep a later encryption retrofit cheap: index columns stay separate from content
columns, so content can become ciphertext without redesigning a query; and search sits behind one
interface, so a local index can replace the server's later.

## 6. Mobile client

A Capacitor shell around a static SvelteKit app, targeting iOS and Android. It is not a PWA, so it
ships through the stores, keeps its assets local, and can hold a SQLite database later.

| Screen | Content |
| --- | --- |
| Projects | Foldable project strips, their threads, and each project's activity cluster |
| Threads | Every thread ordered by what needs the user first, with inbox grouping |
| Conversation | The transcript, a composer that queues a prompt, a drawer of thread facts |
| Account | Identity, device list and revocation, appearance, sign out |

Absent on purpose: terminal, file tree, spec studio, diff review, design and video work, multi-Oven
orchestration, model selection, skill and MCP editing. The phone reads and prompts.

## 7. Phases

Each phase is independently useful and none starts before the one it needs is in use.

### Phase 0: identity
Go service on Postgres with migrations, the control plane tables, email and password with
verification and reset, Google and GitHub, session revocation, readiness.

**Exit:** a user can sign up, sign in with each provider, and see and revoke their sessions and
devices. **State: built.**

### Phase 1: mobile shell
Capacitor projects, brand tokens, sign-in, projects, threads, conversation with polling, account.

**Exit:** the app is installed on a device and reads real content. **State: screens built and
running against the seeded service; offline cache and native projects are the remaining work.**

### Phase 2: per-user store and read API
Provision a schema per user, migrate it, serve projects, threads and messages from it.

**State: built**, with the filtering done on the server.

### Phase 3: prompting and sync
Queued prompts, Oven heartbeat and presence, the sync outbox and pull endpoints, the desktop adapter.

**State: prompts and presence are built; sync and the desktop adapter are not.**

### Phase 4 and later
Push notifications, WebRTC for a live run stream, self-hosted stores with a migration notice, and
the deferred encryption work, which by then has the seam it needs.

## 8. Open questions

1. **The transactional email sender.** Which service, and which domain sends verification and reset.
2. **Retention on the server.** The desktop's message table is never pruned locally and one machine
   already holds 812 MB. The server needs a shorter rule, and the number is not chosen.
3. **Whether the account is required.** The app works entirely offline today. The account stays
   opt-in.
4. **Push notifications.** Needed for a phone that queues a prompt; not designed yet.
5. **Store provisioning timing.** Schema on sign-up, or on first content write.

## 9. Not verified

- Whether Coolify provisions Postgres with a backup path worth relying on, and whether its reverse
  proxy passes WebSocket upgrades cleanly.
- How much a per-user schema costs in planning time once a database holds thousands of them.
- Capacitor's SQLite plugin behaviour under iOS background suspension, which decides how aggressive
  an outbox drain has to be.
- Real ciphertext and plaintext volume per active user, since the only figure available is one local
  database.
