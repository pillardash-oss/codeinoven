# CodeInOven remote control service

This is the account service, desktop registry, enrollment, and opaque WebSocket relay for the
hosted mobile PWA. Both the desktop and phone create outbound connections, so the desktop does not
need an inbound public port and continues to work behind NAT and normal firewalls.

## Run locally

No environment variables are required to boot the development service. Run:

```sh
bun services/remote-control/server.ts
```

To exercise Google or Apple sign-in locally, supply the matching provider credentials from
`.env.example`. Development-only placeholders are otherwise used so the rest of the service can
start without production secrets.

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
- `desktop.enrollment-conflict` and `desktop.profile-synced`
- `desktop.renamed`, `desktop.revoked`, and `desktop.revoked-by-device`
- `relay.desktop-connected` and `relay.desktop-disconnected`

Each row contains the event name, timestamp, and the related user/desktop IDs when available. The
metadata field is currently an empty JSON object reserved for a future versioned schema.

Configure a Google OAuth web client with:

- Authorized redirect URIs:
  - `https://mobile.codeinoven.com/api/auth/callback/google`
  - `https://auth.codeinoven.com/api/auth/callback/google`

Configure Sign in with Apple with:

- A primary App ID with the **Sign in with Apple** capability.
- A Service ID used as `APPLE_OAUTH_CLIENT_ID`.
- Domains: `mobile.codeinoven.com` and `auth.codeinoven.com`.
- Return URLs:
  - `https://mobile.codeinoven.com/api/auth/callback/apple`
  - `https://auth.codeinoven.com/api/auth/callback/apple`
- A Sign in with Apple key, its Team ID and Key ID, and the downloaded `.p8` private key.

Store `APPLE_PRIVATE_KEY` as one line with PEM newlines escaped as `\n`; the service restores the
line breaks before signing.

Google and Apple secrets remain server-only in Coolify. The service generates Apple's required
client-secret JWT at runtime, with a 180-day expiry, whenever an Apple authorization starts.

## Coolify deployment

Required production variables:

- `TRUST_PROXY=1` — enable only when the service is reachable exclusively through the trusted
  reverse proxy shown in `compose.example.yml`.
- `BETTER_AUTH_SECRET` — generate with `openssl rand -base64 32`.
- `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET` — Google Cloud OAuth web client.
- `APPLE_OAUTH_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` — Apple Service
  ID and Sign in with Apple key credentials.

The production service has two explicit public origins. `https://mobile.codeinoven.com` serves the
PWA and remote API; `https://auth.codeinoven.com` is the desktop sign-in entry. Better Auth resolves
only those two approved hosts, so each OAuth flow returns to the host where it started. Proxy-header
trust is explicitly enabled with `TRUST_PROXY=1`; leave it disabled when the service can be reached
directly. SQLite is stored at `/data/remote-control.sqlite` on the named `remote-data` volume. Do not
put OAuth client secrets, the Better Auth secret, or the Apple private key in the PWA container.

- Deploy `compose.example.yml` as a Docker Compose resource.
- Assign both `https://mobile.codeinoven.com` and `https://auth.codeinoven.com` to the `mobile-pwa`
  service on port `80`. Create DNS records for both names before requesting certificates. Do not
  expose the `remote-control` service publicly; the PWA container proxies `/api/auth/*`,
  `/desktop/*`, `/v1/*`, and `/healthz` over the private Compose network. Coolify terminates public
  TLS.
- Set `TRUST_PROXY=1`, `BETTER_AUTH_SECRET`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`,
  `APPLE_OAUTH_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` in Coolify.
  Generate `BETTER_AUTH_SECRET` with `openssl rand -base64 32`.
- Keep one replica of the SQLite service. The named `remote-data` volume persists the database;
  configure WAL-aware backups for that volume before launch.
- SQLite is supported for a single service instance. Use a durable volume, WAL-aware backups, and
  one active instance. Move the repository methods to Postgres before horizontal scaling.
- Enrollment-code consumption, account ownership, and mobile-device registration execute in one
  `BEGIN IMMEDIATE` transaction. Concurrent claims for the same one-time code serialize, and only
  one can commit.

## Desktop OAuth bridge

The desktop opens `https://auth.codeinoven.com/desktop/sign-in` with an OAuth state value, a
localhost callback, and an S256 PKCE challenge. The service validates the callback as an exact
`http://127.0.0.1:<ephemeral-port>/account/callback` URL before starting Google or Apple sign-in.
After Better Auth establishes the account session, the service issues a two-minute, single-use
authorization code. `/v1/desktop-auth/exchange` accepts that code only with the original callback
and matching PKCE verifier, then returns a random 90-day profile token. Raw authorization codes and
profile tokens are never stored; SQLite contains SHA-256 hashes only.

The desktop profile token authenticates `/v1/profile` and can create an account-owned remote
desktop. The phone still claims the QR or one-time code, proving that its non-extractable device key
belongs to the same account before remote control is granted.

`Dockerfile.pwa` builds the renderer inside the image, so deployment never depends on the ignored
local `out/renderer` directory. The internal Caddy server handles SPA fallback, security headers,
and WebSocket proxying; it does not bind host ports 80/443.

## Desktop release variables

Create this GitHub Actions repository variable:

- `CODEINOVEN_GITHUB_CLIENT_ID=<public GitHub App or OAuth App client ID>`

The release and production-build workflows use the checked-in
`https://mobile.codeinoven.com` remote origin. The desktop accepts `REMOTE_API_ORIGIN` only as a
runtime override for development or self-hosting; it is not a production setup variable.

## Enrollment and relay protocol

1. The user signs into the PWA with Google or Apple. Better Auth creates the account when needed
   and stores the session in an HttpOnly cookie.
2. A desktop requests an enrollment and receives a one-time claim code, a relay token, and a
   separate profile-sync token.
3. The signed-in user enters/scans the claim code in the PWA. Codes expire after ten minutes, and
   the PWA binds the claim to a non-extractable P-256 key stored in IndexedDB.
4. The desktop polls enrollment status, creates an ephemeral ECDH grant for that PWA key, stores
   its device token in the OS-backed `SecretVault`, and opens the desktop relay connection.
5. A signed-in PWA selects an account-owned desktop and opens
   `/v1/relay?role=mobile&desktopId=<id>&mobileDeviceId=<id>` using its HttpOnly session cookie.
6. The service authorizes the ownership relationship and forwards opaque `relay:data`
   envelopes while the phone proves its desktop-issued device credential.
7. After device authentication, the existing socket exchanges a WebRTC offer and answer. ICE
   prefers a direct UDP route, uses STUN for NAT traversal, and uses TURN when direct traversal
   fails. Encrypted RPC frames move to the reliable ordered data channel when it opens; the
   authenticated WebSocket remains available as signaling and automatic data fallback.

Set `REMOTE_TURN_URLS` and `REMOTE_TURN_SHARED_SECRET` to the URLs and `use-auth-secret` value of
your Coturn deployment. The service derives short-lived HMAC-SHA1 TURN REST credentials only for
authenticated desktop and phone sockets. If TURN is not configured, direct/STUN WebRTC is still
attempted and the existing cloud WebSocket relay remains the guaranteed route.

The repository includes a standalone Coolify-ready Coturn deployment in
`services/turn/compose.coolify.yml`. Follow `services/turn/README.md` for DNS, raw port, firewall,
shared-secret, and rollout requirements. TURN must be deployed as a raw UDP/TCP service rather than
behind the PWA's HTTP reverse proxy.

The public relay is the guaranteed cross-platform route. When a desktop reports a LAN endpoint,
the PWA also tries the authenticated LAN route; direct LAN requires the desktop certificate to be
trusted on that phone because standard mobile browsers reject self-signed certificates. If browser
private-network or certificate policy blocks it, relay use is automatic. A relay session is
periodically promoted to LAN when the trusted local route becomes available.

Revocation closes every live desktop/mobile socket. Relay payloads are capped at 1 MiB and the
service applies origin checks, request-size limits, Better Auth's OAuth state/session protections,
database-backed auth rate limiting, and per-source relay/enrollment rate limiting.

# Prototype previews

Production prototype links require an explicit HTTPS `CODEINOVEN_PUBLIC_PROTOTYPE_PREVIEW_ORIGIN`. Localhost and `127.0.0.1` values are development-only. The preview origin is public configuration, not a secret, and must remain separate from account authentication and remote API origins.
