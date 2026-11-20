/**
 * The contract between an Oven's own utility host and every client that uses it.
 *
 * A turn that runs on an Oven runs on *that machine*, so the app's loopback
 * gateway is not reachable from it: `http://127.0.0.1:<app port>` names the
 * Oven's own loopback there, where nothing listens. Each Oven therefore hosts
 * its own utility gateway on its own loopback, and this module is the only place
 * that spells out what the host, the relay a client opens, and the state file
 * they agree on look like.
 *
 * Nothing here imports Electron, SvelteKit, or any app-only module: the same
 * source is bundled into the Oven service (`out/main/oven-service.mjs`) and read
 * by this app, exactly like `./ovens`.
 */

/** Version of the host's routes and state file. A host rejects what it cannot parse. */
export const OVEN_UTILITY_HOST_PROTOCOL = 1

/** The argv mode that runs the long-lived host on an Oven. */
export const OVEN_UTILITY_HOST_MODE = 'utility-host'

/**
 * The argv mode that carries one client's turn between the host and the client.
 *
 * The relay is a child of the machine that holds the client connection (this app
 * spawns it over SSH, with a duplex pipe), so it is both the Oven-local listener
 * the host forwards app-bound calls to, and the frame pump that carries those
 * calls to the app and their answers back.
 */
export const OVEN_UTILITY_RELAY_MODE = 'utility-relay'

/** Directory under an Oven's data root that holds the host's state file. */
export const OVEN_UTILITY_HOST_DIRECTORY = 'utility-host'

/** The file any client on the Oven reads to find the host. Written 0600. */
export const OVEN_UTILITY_HOST_STATE_FILE = 'state.json'

/**
 * How long one forwarded call may wait for its client.
 *
 * A gateway call can be human-paced (`cio_ask_secret` holds the tool call open
 * while the user fetches the value), and the client owns that deadline, so the
 * host waits longer than any client does and only gives up when the answer can
 * no longer arrive at all.
 */
export const OVEN_UTILITY_RELAY_CALL_TIMEOUT_MS = 15 * 60 * 1000

/** A JSON value as it crosses the host/relay/client boundary. */
export type OvenUtilityJson =
  string | number | boolean | null | OvenUtilityJson[] | { [key: string]: OvenUtilityJson }

/**
 * What a client finds on the Oven.
 *
 * `hostToken` is a machine credential, not a turn credential: any process that
 * can read this 0600 file is already the user on that machine, so it may mint
 * its own turn. It never leaves the Oven.
 */
export interface OvenUtilityHostState {
  protocolVersion: number
  /** Revision of the service bundle that started the host. */
  revision: string
  /** The loopback port the host listens on. */
  port: number
  hostToken: string
  pid: number
  startedAt: number
}

/**
 * One MCP server, resolved on the Oven by its client.
 *
 * The client owns the registry, so it sends exactly the servers this turn may
 * run here, with the command or URL as the Oven must spell it. Credentials are
 * already resolved: the host runs them and never sees a vault.
 */
export interface OvenUtilityMcpServer {
  utilityId: string
  /** Bearer the client uses for this server, never shown to a model. */
  name: string
  transport: 'stdio' | 'http' | 'sse'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  cwd?: string
}

/** One utility this turn may search and invoke on the Oven. */
export interface OvenUtilityTurnUtility {
  id: string
  kind: string
  name: string
  description: string
  /** Full documentation, so `cio_util_docs_lookup` answers here. */
  docs?: string
  /** MCP server to spawn on this machine, when this utility needs one. */
  server?: OvenUtilityMcpServer
}

/**
 * One turn's authority on the host.
 *
 * A turn is a capability: the HTTP endpoint accepts it as a bearer token, the
 * granted tool names bound what it may call, and it disappears when its client
 * retires it or its relay disconnects. It is not a session: the host holds no
 * conversation state, only what the turn was allowed to do.
 */
export interface OvenUtilityTurn {
  turnId: string
  token: string
  /** Route names this turn may call, as `GATEWAY_TOOLS` spells them. */
  grants: string[]
  /** Utilities this turn may run on the Oven. */
  utilities: OvenUtilityTurnUtility[]
  /**
   * The loopback URL of the turn's relay, when the client has one.
   *
   * A client without a relay (an Oven-local harness, a CLI) leaves this out and
   * the host answers app-bound calls with an explicit "needs its app" error
   * instead of pretending the capability does not exist.
   */
  relayUrl?: string
  /** A short name for the client, for the host's own answers. */
  client: string
  createdAt: number
}

/** What one client asks the host to remember about its turn. */
export type OvenUtilityTurnInput = Pick<
  OvenUtilityTurn,
  'turnId' | 'token' | 'grants' | 'utilities' | 'relayUrl' | 'client'
>

/** One tool call a client's gateway received and the host must forward or run. */
export interface OvenUtilityRelayCall {
  /** Route name, exactly as it arrives on the host (`/invoke`, `/diagnostics`, ...). */
  route: string
  /** Parsed JSON body of the call. */
  input: OvenUtilityJson
}

/**
 * One frame from the client to its relay.
 *
 * `start` carries the whole turn, because the client owns the registry and the
 * grants: the relay only describes them to the host and carries calls. `answer`
 * settles one forwarded call in order, keyed by the id the host minted.
 */
export type OvenUtilityRelayCommand =
  | { kind: 'start'; turn: OvenUtilityTurnInput }
  | { kind: 'answer'; id: string; ok: true; value: OvenUtilityJson }
  | { kind: 'answer'; id: string; ok: false; error: string }
  | { kind: 'stop' }

/**
 * One frame from a relay to its client.
 *
 * `ready` is written once, before any `ask`, so the client learns the port its
 * harness must be pointed at without asking the Oven anything else. From then
 * on the relay only forwards: every `ask` is one call the host could not run on
 * the Oven itself.
 */
export type OvenUtilityRelayEvent =
  | { kind: 'ready'; port: number; hostProtocolVersion: number }
  | { kind: 'ask'; id: string; turnId: string; route: string; input: OvenUtilityJson }
  /** The relay could not register or the host went away; the turn is over. */
  | { kind: 'failed'; error: string }
