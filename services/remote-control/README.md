# CodeInOven remote control service

This is the account, desktop registry, enrollment, and opaque WebSocket relay for the hosted
mobile PWA. Both the desktop and phone create outbound connections, so the desktop does not need
an inbound public port and continues to work behind NAT and normal firewalls.

## Run locally

Set the variables in `.env.example`, then run:

```sh
bun services/remote-control/server.ts
```

Back up the SQLite database using a WAL-aware snapshot. The service deliberately never receives
the desktop control secret: the desktop encrypts a device-bound grant directly to the PWA's
non-extractable Web Crypto key.

## Production topology

- Serve the built PWA at the final `https://mobile.…` origin with a public CA certificate.
- Reverse-proxy `/v1/*` and `/healthz` from that same origin to this service. Same-origin hosting
  keeps the HttpOnly `SameSite=Strict` session cookie compatible across iOS and Android PWAs.
- Enable WebSocket upgrades for `/v1/relay`; cap request bodies and connection counts at the edge.
- Keep the service listener private (`127.0.0.1` by default). Terminate TLS at the reverse proxy.
- SQLite is supported for a single service instance. Use a durable volume, WAL-aware backups, and
  one active instance. Move the repository methods to Postgres before horizontal scaling.

Build the renderer with `bun run build:production`, set `REMOTE_PUBLIC_HOST` to the confirmed
mobile hostname, and use `compose.example.yml` plus `Caddyfile.example` as the single-host
deployment. Caddy obtains and renews the public certificate and proxies the account API and relay
beneath the PWA origin. Set the desktop application's `REMOTE_API_ORIGIN` to that same HTTPS URL.

## Enrollment and relay protocol

1. A desktop requests an enrollment and receives a one-time claim code plus a device token.
2. The signed-in user enters/scans the claim code in the PWA. Codes expire after ten minutes, and
   the PWA binds the claim to a non-extractable P-256 key stored in IndexedDB.
3. The desktop polls enrollment status, creates an ephemeral ECDH grant for that PWA key, stores
   its device token in the OS-backed `SecretVault`, and opens the desktop relay connection.
4. A signed-in PWA selects an account-owned desktop and opens
   `/v1/relay?role=mobile&desktopId=<id>&mobileDeviceId=<id>` using its HttpOnly session cookie.
5. The service authorizes the ownership relationship and forwards only opaque `relay:data`
   envelopes. Desktop RPC remains encrypted by the desktop control secret.

The public relay is the guaranteed cross-platform route. When a desktop reports a LAN endpoint,
the PWA also tries the authenticated LAN route; direct LAN requires the desktop certificate to be
trusted on that phone because standard mobile browsers reject self-signed certificates. If browser
private-network or certificate policy blocks it, relay use is automatic. A relay session is
periodically promoted to LAN when the trusted local route becomes available.

Revocation closes every live desktop/mobile socket. Relay payloads are capped at 1 MiB and the
service applies origin checks, request-size limits, Argon2id password hashing, expiring random
session tokens stored only as hashes, generic login errors, and basic per-source rate limiting.
