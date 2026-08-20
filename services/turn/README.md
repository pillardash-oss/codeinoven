# CodeInOven TURN service

This service runs Coturn as the WebRTC fallback between the desktop and PWA when ICE cannot create
a direct peer-to-peer route. The remote-control service generates short-lived TURN REST
credentials; Coturn validates them with the same shared secret. The permanent secret is never sent
to either client.

The image is pinned to the official `coturn/coturn:4.17.2-r0-alpine` release. It runs as the
unprivileged `nobody` user, writes its generated secret-bearing configuration only to `/tmp`,
disables the administrative CLI and unused TLS/DTLS listeners, retains Coturn's default loopback
denial, rejects multicast peers, and exposes a STUN-based container health check. See the
[official Coturn Docker guidance](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md)
for the underlying image and network requirements.

## Coolify deployment

Create this as a **separate Docker Compose resource** in Coolify:

1. Select this repository and `services/turn/compose.coolify.yml` as the Compose file.
2. Do not assign a Coolify domain. TURN is not HTTP and must not pass through Traefik/Caddy.
3. Add the environment variables from `services/turn/.env.example`.
4. Point a DNS-only `A` record for `turn.codeinoven.com` directly to the server's public IPv4
   address. Do not enable an HTTP proxy/CDN for this record.
5. Open these inbound ports in both the provider firewall and the server firewall:
   - `3478/udp`
   - `3478/tcp`
   - `49160-49200/udp`
6. Deploy one replica. The Compose service uses host networking so the relay ports map directly and
   preserve the public port numbers Coturn advertises.

Use a stable public IP for `TURN_EXTERNAL_IP`. `auto` uses Coturn's public-IP detector and is useful
for initial setup, but an explicit stable IP makes restarts deterministic. If the service is moved
behind a one-to-one NAT, set `TURN_EXTERNAL_IP` to the public IP and `TURN_RELAY_IP` to the private
IP. Leave `TURN_RELAY_IP` empty when host networking exposes the server's public interface directly.

The default `49160-49200` relay range supports a modest initial deployment. Increase the range in
both the Coolify variables and firewall as concurrent relay demand grows. `TURN_MIN_PORT` and
`TURN_MAX_PORT` must always describe the same range allowed by the firewall.

## Connect the remote-control service

Generate one shared secret:

```sh
openssl rand -base64 48
```

Set the output in both places:

- TURN service: `TURN_SHARED_SECRET`
- Remote-control service: `REMOTE_TURN_SHARED_SECRET`

Then set these variables on the remote-control service:

```dotenv
REMOTE_STUN_URLS=stun:turn.codeinoven.com:3478
REMOTE_TURN_URLS=turn:turn.codeinoven.com:3478?transport=udp,turn:turn.codeinoven.com:3478?transport=tcp
REMOTE_TURN_CREDENTIAL_TTL_SECONDS=3600
```

Redeploy the TURN service first, then redeploy the remote-control service. Do not put either shared
secret in the PWA, Electron renderer, public build arguments, or repository variables.

## Dockerfile-only deployment

If Coolify is configured as a Dockerfile application instead of Compose, use repository root as the
build context and `services/turn/Dockerfile` as the Dockerfile. Configure host networking for the
container. If host networking is unavailable, publish `3478` over both TCP and UDP plus the complete
UDP relay range with identical host/container port numbers; Dockerfile `EXPOSE` declarations do not
publish firewall ports by themselves.

## Verification

Check that the container is healthy, then verify UDP and TCP allocation from a network outside the
server. A listening-port check alone is insufficient because a TURN allocation also needs the
advertised public IP and relay range to be reachable. Browser ICE diagnostics should show a
`relay` candidate when direct connectivity is deliberately blocked.
