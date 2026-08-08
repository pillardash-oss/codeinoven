# CodeInOven remote control service

This is the GitHub account, entitlement, desktop registry, enrollment, and opaque WebSocket relay
for the hosted mobile PWA. Both the desktop and phone create outbound connections, so the desktop
does not need an inbound public port and continues to work behind NAT and normal firewalls.

## Run locally

Set the variables in `.env.example`, then run:

```sh
bun services/remote-control/server.ts
```

Back up the SQLite database using a WAL-aware snapshot. The service deliberately never receives
the desktop control secret: the desktop encrypts a device-bound grant directly to the PWA's
non-extractable Web Crypto key.

## GitHub identity

Better Auth is the sole hosted-account authority. GitHub OAuth creates one canonical user ID that
owns remote desktops and is also the key for the server-owned `account_entitlements` record used
by current or future Pro access. There is no separate remote password.

Configure a GitHub App or OAuth App with:

- Callback URL: `https://mobile.codeinoven.com/api/auth/callback/github`
- GitHub App account permission: **Email addresses — Read-only**
- Device Flow enabled if the same GitHub App client ID is used by packaged desktops

The server needs the client ID and client secret. The desktop build receives only the public
client ID; the client secret must remain in Coolify.

## Coolify deployment

- Deploy `compose.example.yml` as a Docker Compose resource.
- Assign `https://mobile.codeinoven.com` to the `mobile-pwa` service on port `80`. Do not expose
  the `remote-control` service publicly; the PWA container proxies `/api/auth/*`, `/v1/*`, and
  `/healthz` over the private Compose network. Coolify terminates public TLS.
- Set `REMOTE_PUBLIC_HOST`, `BETTER_AUTH_SECRET`, `CODEINOVEN_GITHUB_CLIENT_ID`, and
  `GITHUB_OAUTH_CLIENT_SECRET` in Coolify. Generate `BETTER_AUTH_SECRET` with
  `openssl rand -base64 32`.
- Keep one replica of the SQLite service. The named `remote-data` volume persists the database;
  configure WAL-aware backups for that volume before launch.
- SQLite is supported for a single service instance. Use a durable volume, WAL-aware backups, and
  one active instance. Move the repository methods to Postgres before horizontal scaling.

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

1. The user signs into the PWA with GitHub. Better Auth stores the session in an HttpOnly cookie.
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
