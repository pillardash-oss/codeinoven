# The Oven utility host

Every app-managed capability a turn can reach (installed MCP servers, skills, web
search, diagnostics, secrets, app control, the artifact tools) is served by one
loopback HTTP gateway. A turn whose harness runs on a remote Oven runs on _that_
machine, so `127.0.0.1:<port>` there is the Oven's own loopback and the app's
gateway is unreachable. Every such turn used to fail every capability call with
`ECONNREFUSED`.

So each Oven hosts its own gateway.

## Shape

- **Host** (`src/main/ovens/remote/oven-utility-host.ts`, argv mode
  `utility-host`): started once per Oven by the Oven service daemon, bound to the
  Oven's `127.0.0.1:0`. It publishes `utility-host/state.json` under the Oven data
  root (`~/.config/pillardash/codeinoven/ovens`), mode 0600, holding
  `{ protocolVersion, revision, port, hostToken, pid, startedAt }`. Any process on
  that machine which can read that file is the user, so any of them may mint its
  own turn.
- **Turn** is a capability: a `turnId`, a bearer token, the granted tool names,
  the utility snapshot the turn may use, the checkout it works in
  (`projectPath`, which is what a local search ranks against), and optionally the
  loopback URL of its client's relay. The host answers only routes the grants
  allow, and retires a turn when its client retires it, its relay disconnects, or
  it idles out.
- **Relay** (argv mode `utility-relay`, spawned per turn by the client over SSH
  with a duplex pipe): registers the turn with the host, reports the _host's_
  port as its first frame, then carries every call the host cannot run itself
  back to the client and returns its answer.
- **The app** publishes the Oven's endpoint for a turn that runs there
  (`resolveGatewayEndpoint` in the turn runtime → `OvenUtilityRelays`), and
  answers relayed calls through the same `callRouteForTurn` a local turn uses, so
  a route has exactly one implementation.

## Who runs what

| Route                                                                | Runs on the Oven                                       | Forwarded to the app                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------- |
| `cio_util_find`                                                      | yes, over the turn's snapshot                          | when nothing in it matches, so the app's live registry answers |
| `cio_util_docs_lookup`                                               | yes, for a utility the snapshot carries                | for an id it does not carry                                    |
| `cio_util_init`, `cio_util_use`                                      | yes, for MCP servers and skills that machine can start | anything the Oven cannot start                                 |
| `cio_util_manage`                                                    | —                                                      | yes (the registry lives in the app)                            |
| `cio_util_diagnose`, `cio_ask_secret`, `cio_util_suggest`            | —                                                      | yes (threads, logs, vault, cards)                              |
| app control, orchestration, engineering, pawn, don, `ext_simulation` | —                                                      | yes (Electron state)                                           |

Local execution always falls back to forwarding: a server that will not spawn or
connect makes the call travel to the app rather than fail, and the reason is
logged once per utility.

## Contract

`src/lib/oven-utility-host.ts` is the only place that spells out the state file,
the turn capability, the relay frames and their versions. It is shared by the
bundled Oven service (`out/main/oven-service.mjs`) and the app, so it must never
import Electron, SvelteKit or any app-only module.

## Credentials

A stdio MCP server on the Oven cannot start without its token, and a remote one
cannot authenticate without its headers, so the app resolves the turn's
credential environment and request headers from the vault and sends them with
the snapshot, for the utilities that turn may reach. By default those values
live in the host's memory for the turn, are handed only to the server process or
request they belong to, and are gone when the turn retires: a disposable Oven,
or a stolen image of it, holds nothing to lift.

### Keeping them on the Oven (opt-in, per Oven)

A client with no app behind it — an Oven-local harness pointed at the host's
port, the `cio-oven` CLI — would otherwise never receive a credential, so the
turn's servers could not start. Per Oven, the user may allow that machine to keep
utility credentials at rest: Ovens → _Keep utility credentials on this Oven_.

- The store uses what the Oven's own operating system offers: the login keychain
  (`security`), a secret service (`secret-tool`, which needs a session bus), or
  DPAPI (`ConvertTo-SecureString`). It is probed before it is used; a machine
  with none of them, or a Linux box with no session bus, reports itself
  unavailable and keeps running on the per-turn push. The app never asks an
  unattended launch for a keyring item, exactly as its own `safeStorage` use does.
- The app's vault stays authoritative. A credential the turn carries wins for
  that turn and overwrites the stored copy, so a rotated token lands on the Oven
  on its next turn rather than going stale there.
- A turn that carries no value for a utility falls back to the stored one, which
  is the whole point for client-less turns.
- Values are write-only across the API: no route returns one, and the store's
  `secrets.json` holds only the enabled flag and the ids it holds, never a value.
  Turning the switch off forgets everything on that machine.

## Output and observability

An Oven's answer is shortened at the app's own text limit before it reaches the
model, and nothing spills to disk there. When the Oven cannot run a capability
it forwards the call instead of failing it, and records why once in
`utility-host/host.log` under the Oven data root (bounded to 1 MiB).
