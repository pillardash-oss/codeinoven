# CodeInOven remote control service

This is the account service, desktop registry, enrollment, and opaque WebSocket relay for the
hosted mobile PWA. Both the desktop and phone create outbound connections, so the desktop does not
need an inbound public port and continues to work behind NAT and normal firewalls.

## Run locally

Set the variables in `.env.example`, then run:

```sh
bun services/remote-control/server.ts
```

Back up the SQLite database using a WAL-aware snapshot. The service deliberately never receives
the desktop control secret: the desktop encrypts a device-bound grant directly to the PWA's
non-extractable Web Crypto key.

## Account identity

Better Auth is the sole hosted-account authority. Google or Apple sign-in creates one canonical
user ID that owns remote desktops. First sign-in creates the account automatically; later sign-ins
return to it. GitHub authorization belongs to the desktop workspace sidebar and remains independent
from this account. CodeInOven is permanently free: the service has no payment tiers, subscriptions,
billing state, or entitlement records. There is no separate remote password.

## Audit events

The hosted audit log records security lifecycle event names only; it does not store prompts, files,
terminal contents, desktop control payloads, OAuth tokens, or relay frame contents. The complete
event set is:

- `desktop.enrollment-created`, `desktop.claimed`, and `desktop.control-grant-created`
- `desktop.renamed`, `desktop.revoked`, and `desktop.revoked-by-device`
- `relay.desktop-connected` and `relay.desktop-disconnected`

Each row contains the event name, timestamp, and the related user/desktop IDs when available. The
metadata field is currently an empty JSON object reserved for a future versioned schema.

Configure a Google OAuth web client with:

- Authorized redirect URI: `https://mobile.codeinoven.com/api/auth/callback/google`

Configure Sign in with Apple with:

- A primary App ID with the **Sign in with Apple** capability.
- A Service ID used as `APPLE_OAUTH_CLIENT_ID`.
- Domain: `mobile.codeinoven.com`.
- Return URL: `https://mobile.codeinoven.com/api/auth/callback/apple`.
- A Sign in with Apple key, its Team ID and Key ID, and the downloaded `.p8` private key.

Store `APPLE_PRIVATE_KEY` as one line with PEM newlines escaped as `\n`; the service restores the
line breaks before signing.

Google and Apple secrets remain server-only in Coolify. The service generates Apple's required
client-secret JWT at runtime, with a 180-day expiry, whenever an Apple authorization starts.

## Coolify deployment

Required production variables:

- `REMOTE_PUBLIC_HOST=mobile.codeinoven.com` — Compose uses this to derive `BETTER_AUTH_URL` and
  `REMOTE_ALLOWED_ORIGINS`.
- `BETTER_AUTH_SECRET` — generate with `openssl rand -base64 32`.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` — Google Cloud OAuth web client.
- `APPLE_OAUTH_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` — Apple Service
  ID and Sign in with Apple key credentials.
- `REMOTE_TRUST_PROXY=true` — trust Caddy's validated client-IP forwarding inside Compose.

The service container also receives `BETTER_AUTH_URL=https://mobile.codeinoven.com`,
`REMOTE_ALLOWED_ORIGINS=https://mobile.codeinoven.com`, and
`REMOTE_DATABASE_PATH=/var/lib/codeinoven/remote-control.sqlite` from the Compose file. Do not put
OAuth client secrets, the Better Auth secret, or the Apple private key in the PWA container.

- Deploy `compose.example.yml` as a Docker Compose resource.
- Assign `https://mobile.codeinoven.com` to the `mobile-pwa` service on port `80`. Do not expose
  the `remote-control` service publicly; the PWA container proxies `/api/auth/*`, `/v1/*`, and
  `/healthz` over the private Compose network. Coolify terminates public TLS.
- Set `REMOTE_PUBLIC_HOST`, `BETTER_AUTH_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, `APPLE_OAUTH_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and
  `APPLE_PRIVATE_KEY` in Coolify. Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.
- Keep one replica of the SQLite service. The named `remote-data` volume persists the database;
  configure WAL-aware backups for that volume before launch.
- SQLite is supported for a single service instance. Use a durable volume, WAL-aware backups, and
  one active instance. Move the repository methods to Postgres before horizontal scaling.
- Enrollment-code consumption, account ownership, and mobile-device registration execute in one
  `BEGIN IMMEDIATE` transaction. Concurrent claims for the same one-time code serialize, and only
  one can commit.

`Dockerfile.pwa` builds the renderer inside the image, so deployment never depends on the ignored
local `out/renderer` directory. The internal Caddy server handles SPA fallback, security headers,
and WebSocket proxying; it does not bind host ports 80/443.

## Desktop release variables

Create these GitHub Actions repository variables:

- `REMOTE_API_ORIGIN=https://mobile.codeinoven.com`
- `CODEINOVEN_GITHUB_CLIENT_ID=<public GitHub App or OAuth App client ID>`

The release and production-build workflows pass the GitHub client ID through unchanged and map the
remote origin to `MAIN_VITE_REMOTE_API_ORIGIN`. The remote origin has a checked-in production
default, while the desktop still accepts `REMOTE_API_ORIGIN` as a runtime override for development
or self-hosting.

## Enrollment and relay protocol

1. The user signs into the PWA with Google or Apple. Better Auth creates the account when needed
   and stores the session in an HttpOnly cookie.
2. A desktop requests an enrollment and receives a one-time claim code plus a device token.
3. The signed-in user enters/scans the claim code in the PWA. Codes expire after ten minutes, and
   the PWA binds the claim to a non-extractable P-256 key stored in IndexedDB.
4. The desktop polls enrollment status, creates an ephemeral ECDH grant for that PWA key, stores
   its device token in the OS-backed `SecretVault`, and opens the desktop relay connection.
5. A signed-in PWA selects an account-owned desktop and opens
   `/v1/relay?role=mobile&desktopId=<id>&mobileDeviceId=<id>` using its HttpOnly session cookie.
6. The service authorizes the ownership relationship and forwards only opaque `relay:data`
   envelopes. Desktop RPC remains encrypted by the desktop control secret.

The public relay is the guaranteed cross-platform route. When a desktop reports a LAN endpoint,
the PWA also tries the authenticated LAN route; direct LAN requires the desktop certificate to be
trusted on that phone because standard mobile browsers reject self-signed certificates. If browser
private-network or certificate policy blocks it, relay use is automatic. A relay session is
periodically promoted to LAN when the trusted local route becomes available.

Revocation closes every live desktop/mobile socket. Relay payloads are capped at 1 MiB and the
service applies origin checks, request-size limits, Better Auth's OAuth state/session protections,
database-backed auth rate limiting, and per-source relay/enrollment rate limiting.
