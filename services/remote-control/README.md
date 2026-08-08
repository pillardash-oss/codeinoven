# CodeInOven remote control service

This is the account, desktop registry, enrollment, and opaque WebSocket relay for the hosted
mobile PWA. Both the desktop and phone create outbound connections, so the desktop does not need
an inbound public port and continues to work behind NAT and normal firewalls.

## Run locally

Generate a master key, set the variables in `.env.example`, then run:

```sh
bun services/remote-control/server.ts
```

The master key wraps desktop control secrets at rest and must come from the production secret
manager. Losing it makes enrolled desktop secrets unrecoverable; exposing it compromises those
secrets. Back up the SQLite database and key separately.

## Production topology

- Serve the built PWA at the final `https://mobile.…` origin with a public CA certificate.
- Reverse-proxy `/v1/*` and `/healthz` from that same origin to this service. Same-origin hosting
  keeps the HttpOnly `SameSite=Strict` session cookie compatible across iOS and Android PWAs.
- Enable WebSocket upgrades for `/v1/relay`; cap request bodies and connection counts at the edge.
- Keep the service listener private (`127.0.0.1` by default). Terminate TLS at the reverse proxy.
- SQLite is supported for a single service instance. Use a durable volume, WAL-aware backups, and
  one active instance. Move the repository methods to Postgres before horizontal scaling.

## Enrollment and relay protocol

1. A desktop requests an enrollment and receives a one-time claim code plus a device token.
2. The signed-in user enters/scans the claim code in the PWA. Codes expire after ten minutes.
3. The desktop polls enrollment status with its device token, stores that token in the OS-backed
   `SecretVault`, and opens `wss://<mobile-origin>/v1/relay?role=desktop`.
4. A signed-in PWA selects an account-owned desktop and opens
   `/v1/relay?role=mobile&desktopId=<id>` using its HttpOnly session cookie.
5. The service authorizes the ownership relationship and forwards only opaque `relay:data`
   envelopes. Desktop RPC remains encrypted by the desktop control secret.

Revocation closes every live desktop/mobile socket. Relay payloads are capped at 1 MiB and the
service applies origin checks, request-size limits, Argon2id password hashing, expiring random
session tokens stored only as hashes, generic login errors, and basic per-source rate limiting.
