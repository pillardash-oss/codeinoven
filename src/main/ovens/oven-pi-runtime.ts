import { randomUUID } from 'node:crypto'
import type { OvenRun, StartOvenRunInput } from '../../lib/ovens'
import { isRemoteOvenId } from '../../lib/ovens'
import type { ThreadSettings } from '../../lib/types'
import type { HarnessDriver } from '../drivers/driver.interface'
import type { PiRpcLaunch, PiRpcLaunchInput, PiRpcLaunchResult } from '../drivers/pi/pi-driver-rpc'
import type { PiCioFilesStorage } from '../drivers/pi/pi-driver-cio-files'
import type { PiNativeTranscriptSource } from '../drivers/pi/pi-native-session'
import { ovenRpcTransport, type OvenRunService } from './oven-rpc-transport'
import { OvenPiStorage, type OvenPiStorageService } from './oven-pi-storage'
import type { OvenUtilityRelays } from './oven-utility-relay'
import type { OvenUtilityTurnUtility } from '../../lib/oven-utility-host'
import {
  ovenPiTranscriptSource,
  type OvenPiTranscriptRoute,
  type OvenPiTranscriptService
} from './oven-pi-transcripts'
import {
  publishOvenPiExtensions,
  readPiExtensionFiles,
  type OvenPiExtensionService,
  type PiExtensionSourcePaths
} from './oven-pi-extensions'
import { ovenDirKey } from './remote/oven-root-paths'

/**
 * One pi session's route to an Oven.
 *
 * The driver above this seam only knows that a session's peer is not this
 * process's child; everything about where that peer runs lives here, keyed by
 * the session id the driver launches with. `cwd` is the Oven checkout the turn
 * works in, `root` is the app-owned Oven directory its handoff files land in,
 * and `environment` is the account environment the Oven syncs for the turn.
 */
export interface OvenPiSession {
  /** The Oven this session's process is started on. */
  ovenId: string
  /** The checkout the Oven-side pi runs in. */
  cwd: string
  /** The app-owned directory this session's handoff files live under, on the Oven. */
  root: string
  /** The environment the run is started with on the Oven. */
  environment: Record<string, string>
  /** The `--extension <path>` argv this session's Oven modules need. */
  extensionArgs: string[]
  /** The Oven client this session's run is polled and written through. */
  transportService: OvenRunService
}

/**
 * The sessions routed to an Oven, by session id.
 *
 * A driver instance serves every thread of its harness, and only the Oven layer
 * knows which of them run elsewhere, so the route is installed per session and
 * removed when the session is dropped. A session with no binding is a local
 * session, and it launches exactly as it always has.
 */
export class OvenPiSessions {
  private readonly sessions = new Map<string, OvenPiSession>()

  /** Route one session to an Oven, replacing any earlier route. */
  bind(sessionId: string, session: OvenPiSession): void {
    this.sessions.set(sessionId, session)
  }

  /** The Oven one session runs on, or undefined when it runs here. */
  get(sessionId: string): OvenPiSession | undefined {
    return this.sessions.get(sessionId)
  }

  /** Drop one session's route so a reused id never inherits a stale machine. */
  forget(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  /** Drop every route (application teardown). */
  clear(): void {
    this.sessions.clear()
  }

  /**
   * The route whose checkout is one project path, newest binding first.
   *
   * The transcript reader is addressed by the checkout pi works in, because
   * that path is what pi encodes into its own session directory. A path no
   * bound session works in belongs to no Oven here, so it resolves to nothing
   * and the caller reads this machine instead.
   */
  routeFor(projectPath: string): OvenPiSession | undefined {
    const wanted = comparablePath(projectPath)
    if (!wanted) return undefined
    const routes = [...this.sessions.values()]
    for (let index = routes.length - 1; index >= 0; index -= 1) {
      const session = routes[index]
      if (session && comparablePath(session.cwd) === wanted) return session
    }
    return undefined
  }
}

/** One checkout path in the single spelling a comparison can rely on. */
function comparablePath(value: string): string {
  return value.replace(/\\/gu, '/').replace(/\/+$/u, '')
}

/** The slice of the Oven client a remote pi run needs to be started. */
export interface OvenPiLaunchService extends OvenRunService {
  start(ovenId: string, input: StartOvenRunInput): Promise<OvenRun>
}

/**
 * The launcher the reserved Oven pi driver carries.
 *
 * Besides starting a session's process on the Oven, it carries where that
 * machine keeps pi's own session transcripts, so the driver's resume path can
 * open the copy the Oven-side pi wrote instead of looking on this computer.
 */
export interface OvenPiLaunch extends PiRpcLaunch {
  readonly nativeTranscripts?: PiNativeTranscriptSource
}

/**
 * The `--extension` flag a pi spawn is given, in both spellings argv can carry.
 */
const EXTENSION_FLAG = '--extension'
const EXTENSION_EQUALS = '--extension='

/**
 * The argv the Oven-side pi is started with.
 *
 * The driver prepares an argv for THIS machine: the bundled runtime's own entry
 * module, and the extension modules the local materialization wrote. An Oven
 * resolves neither, so the local entry module and every extension path that is
 * not already inside this session's Oven directory are dropped, and the
 * session's own published extension args are appended instead. A path that
 * already lives under the session's Oven directory is the machine's own path
 * and stays: that is the core-tools module the driver materialized there
 * through the session's remote handoff storage.
 */
export function ovenPiOvenArgs(
  args: readonly string[],
  session: Pick<OvenPiSession, 'root' | 'extensionArgs'>
): string[] {
  const kept: string[] = []
  const extensions: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === undefined) continue
    if (arg === EXTENSION_FLAG) {
      const path = args[index + 1]
      index += 1
      if (path !== undefined && onOven(path, session.root)) extensions.push(EXTENSION_FLAG, path)
      continue
    }
    if (arg.startsWith(EXTENSION_EQUALS)) {
      const path = arg.slice(EXTENSION_EQUALS.length)
      if (onOven(path, session.root)) extensions.push(EXTENSION_FLAG, path)
      continue
    }
    kept.push(arg)
  }
  // The bundled runtime is started as `<executable> <bundle entry> --mode rpc`:
  // the entry module is a file on this machine, and the Oven's own `pi` is the
  // peer there, so a leading path that is not a flag is dropped with the rest
  // of this machine's argv.
  const command = kept[0] !== undefined && !kept[0].startsWith('-') && looksLikePath(kept[0])
  return [...(command ? kept.slice(1) : kept), ...extensions, ...session.extensionArgs]
}

/** Whether one argv path is already an absolute path on the Oven's own root. */
function onOven(path: string, root: string): boolean {
  if (!path) return false
  const normalized = path.replace(/\\/gu, '/')
  const base = root.replace(/\\/gu, '/').replace(/\/+$/u, '')
  return normalized === base || normalized.startsWith(`${base}/`)
}

/** A leading argv entry that names a module file rather than a flag. */
function looksLikePath(arg: string): boolean {
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/u.test(arg) || /\.(?:js|mjs|cjs)$/iu.test(arg)
}

/**
 * The launcher every Oven-bound pi session starts through.
 *
 * It receives exactly what the local spawn would have used   the command, the
 * argv, the directory and the environment   and starts the same argv on the
 * session's Oven instead of here, returning the transport that speaks pi's RPC
 * protocol to that run. A session with no binding is a bug in the caller, not a
 * reason to spawn anything: the driver only carries a launcher on the instance
 * reserved for Oven turns.
 */
export function createOvenPiLaunch(input: {
  sessions: OvenPiSessions
  service: OvenPiLaunchService
  /**
   * Where the sessions this launcher starts keep pi's own transcripts.
   *
   * A session resumed on that machine must open the Oven's own session file, so
   * the source travels with the launcher the driver already receives and the
   * driver's native-transcript seam reads through it (see `PiDriver`).
   */
  nativeTranscripts?: PiNativeTranscriptSource
}): OvenPiLaunch {
  const launch: PiRpcLaunch = async (launchInput: PiRpcLaunchInput): Promise<PiRpcLaunchResult> => {
    const session = input.sessions.get(launchInput.sessionId)
    if (!session)
      throw new Error(
        `No Oven is bound to Pi session ${launchInput.sessionId}, so this turn cannot start there.`
      )
    const runId = randomUUID()
    let run: OvenRun
    try {
      run = await input.service.start(session.ovenId, {
        id: runId,
        command: 'pi',
        args: ovenPiOvenArgs(launchInput.args, session),
        cwd: session.cwd,
        // The driver composes the environment the local spawn would have used,
        // and that is where the custom providers' API keys ride. The session's
        // own environment is the account the Oven synced, so the two are merged
        // here: dropping the driver's half would leave every provider key empty
        // on the Oven. The remote PATH and HOME stay the Oven's own.
        environment: ovenPiRunEnvironment(session.environment, launchInput.env),
        // An RPC session is a conversation, not a one-shot run: its input stays
        // open for the prompts and controls the driver writes after launch.
        input: '',
        closeInput: false
      })
    } catch (error) {
      // The service's own message is the only useful one here: it names what the
      // Oven refused (a missing harness, a missing directory, a dead channel).
      throw new Error(messageOf(error), { cause: error })
    }
    return {
      transport: ovenRpcTransport({
        service: session.transportService,
        ovenId: session.ovenId,
        runId: run.id || runId
      })
    }
  }
  return Object.assign(
    launch,
    input.nativeTranscripts ? { nativeTranscripts: input.nativeTranscripts } : {}
  )
}

/**
 * The environment one Oven pi run starts with.
 *
 * The Oven keeps its own PATH and HOME: it is the machine that resolves the
 * harness and the runtime, and a value from this computer would name paths that
 * do not exist there. Everything else the driver composed (a provider's API key,
 * a session marker) is exactly what a local child would have received, so it is
 * forwarded.
 */
export function ovenPiRunEnvironment(
  session: Record<string, string>,
  composed: NodeJS.ProcessEnv
): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(composed)) {
    if (typeof value !== 'string' || value.length === 0) continue
    if (OVEN_OWNED_ENVIRONMENT.has(name)) continue
    if (value.includes('\0')) continue
    // The Oven enforces this name shape and length on every override it
    // accepts, so anything else must not be sent: a development shell exports
    // plenty of lowercase names (`npm_config_*`, `npm_package_*`), and one of
    // them made the whole run fail with "Invalid remote environment override"
    // instead of starting the turn.
    if (!OVEN_ENVIRONMENT_NAME.test(name)) continue
    if (value.length > 32_768) continue
    environment[name] = value
  }
  return { ...environment, ...session }
}

/** The name shape and value bound the Oven accepts for an environment override. */
const OVEN_ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]*$/u

/** Variables the Oven must keep from its own session, never from this machine. */
const OVEN_OWNED_ENVIRONMENT = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE'
])

/** Where one pi session's app-owned Oven files live. */
export function ovenPiSessionsRoot(dataRoot: string, sessionId: string): string {
  return `${dataRoot.replace(/\/+$/u, '')}/pi-sessions/${ovenDirKey(sessionId)}`
}

/**
 * What the Oven preparation leaves a pi turn that no other harness needs.
 *
 * `root` is the checkout the turn works in, `dataRoot` is the Oven's app data
 * root (where the session's own directory is created), and `environment` is the
 * account environment the Oven syncs for the turn.
 */
export interface OvenPiTurnPreparation {
  root: string
  dataRoot: string
  environment: Record<string, string>
}

/**
 * The handoff file surface one Oven pi session reads and writes.
 *
 * The files themselves belong to the Oven, so pi's extension reads what the
 * driver publishes there; the one setting they are composed with (the app's
 * question cap) is this device's, exactly as `PiCioFilesStorage` describes.
 */
export function ovenPiSessionStorage(input: {
  service: OvenPiStorageService
  ovenId: string
  root: string
  config: () => Promise<{ agentQuestionCap: number }>
}): PiCioFilesStorage {
  const files = new OvenPiStorage({
    service: input.service,
    ovenId: input.ovenId,
    root: input.root
  })
  return {
    resolve: (relativePath) => files.resolve(relativePath),
    readRaw: (relativePath) => files.readRaw(relativePath),
    writeRaw: (relativePath, content) => files.writeRaw(relativePath, content),
    remove: (relativePath) => files.remove(relativePath),
    getConfig: input.config
  }
}

/**
 * Bind one session to the Oven its turn is about to run on.
 *
 * The extensions are published only when the caller has the local modules the
 * driver materialized (see `PiExtensionSourcePaths`): without them the session
 * still starts, with the extension paths the driver itself wrote onto the Oven
 * through the session's remote handoff storage.
 */
export async function prepareOvenPiSession(input: {
  service: OvenPiExtensionService & OvenRunService
  ovenId: string
  sessionId: string
  prepared: OvenPiTurnPreparation
  extensionSources?: PiExtensionSourcePaths
}): Promise<OvenPiSession> {
  const extensionArgs = input.extensionSources
    ? (
        await publishOvenPiExtensions({
          service: input.service,
          ovenId: input.ovenId,
          sessionId: input.sessionId,
          files: await readPiExtensionFiles(input.extensionSources)
        })
      ).extensionArgs
    : []
  return {
    ovenId: input.ovenId,
    cwd: input.prepared.root,
    root: ovenPiSessionsRoot(input.prepared.dataRoot, input.sessionId),
    environment: input.prepared.environment,
    extensionArgs,
    transportService: input.service
  }
}

/** The Oven client every part of a remote pi run goes through. */
export type OvenPiRuntimeService = OvenPiExtensionService &
  OvenPiLaunchService &
  OvenPiStorageService &
  OvenPiTranscriptService

/**
 * The one shared Oven pi runtime: the session routes, the launcher the reserved
 * pi driver carries, and the client they all speak through.
 *
 * Constructed once per application and never per turn, so a session's route
 * outlives the turn that created it and the next turn on the same thread finds
 * the same machine.
 */
export class OvenPiRuntime {
  readonly sessions = new OvenPiSessions()
  readonly launch: OvenPiLaunch
  private piDriver: (HarnessDriver & OvenPiDriver) | null = null
  private transcriptSource: PiNativeTranscriptSource | null = null
  private utilityRelays: OvenUtilityRelays | null = null

  constructor(readonly service: OvenPiRuntimeService) {
    this.launch = createOvenPiLaunch({
      sessions: this.sessions,
      service: this.service,
      nativeTranscripts: this.nativeTranscripts
    })
  }

  /**
   * Where the sessions on this runtime's Ovens keep pi's own transcripts.
   *
   * The driver that starts pi there reads through this, which is what makes a
   * session resumed on an Oven open the Oven's own session file. The account
   * root is the one that session's pi was started with, so an Oven running a
   * managed account reads that account's directory and not the machine's
   * default one.
   */
  get nativeTranscripts(): PiNativeTranscriptSource {
    return (this.transcriptSource ??= ovenPiTranscriptSource({
      service: this.service,
      route: (projectPath) => this.transcriptRoute(projectPath)
    }))
  }

  /** One project path's Oven and account root, or null when nothing runs there. */
  private transcriptRoute(projectPath: string): OvenPiTranscriptRoute | null {
    const session = this.sessions.routeFor(projectPath)
    const agentDirectory = session?.environment['PI_CODING_AGENT_DIR']?.trim()
    if (!session || !agentDirectory) return null
    return { ovenId: session.ovenId, agentDirectory }
  }

  /** The pi driver this runtime starts sessions on. */
  get driver(): (HarnessDriver & OvenPiDriver) | null {
    return this.piDriver
  }

  /**
   * Hand the runtime the pi driver reserved for Oven turns.
   *
   * It has to be a driver of its own: a launcher is chosen for the whole driver,
   * and installing one on the driver this machine's local pi turns use would
   * start those turns somewhere else too.
   */
  attachDriver(driver: HarnessDriver & OvenPiDriver): void {
    this.piDriver = driver
  }

  /** Prepare and route one session, and give it its Oven handoff storage. */
  async bind(input: {
    sessionId: string
    ovenId: string
    prepared: OvenPiTurnPreparation
    extensionSources?: PiExtensionSourcePaths
    config: () => Promise<{ agentQuestionCap: number }>
  }): Promise<OvenPiSession> {
    const session = await prepareOvenPiSession({
      service: this.service,
      ovenId: input.ovenId,
      sessionId: input.sessionId,
      prepared: input.prepared,
      ...(input.extensionSources ? { extensionSources: input.extensionSources } : {})
    })
    this.sessions.bind(input.sessionId, session)
    this.piDriver?.setSessionStorage(
      input.sessionId,
      ovenPiSessionStorage({
        service: this.service,
        ovenId: input.ovenId,
        root: session.root,
        config: input.config
      })
    )
    return session
  }

  /** Drop one session's route and its remote handoff storage. */
  forget(sessionId: string): void {
    this.sessions.forget(sessionId)
    this.piDriver?.setSessionStorage(sessionId, null)
  }

  /**
   * Hand the runtime the relays that carry a turn's gateway back to this app.
   *
   * Built by the wiring because they need both halves: the Oven's transport to
   * open a child on the machine, and the app's gateway to answer the calls that
   * machine cannot run itself.
   */
  attachUtilityRelays(relays: OvenUtilityRelays): void {
    this.utilityRelays = relays
  }

  /**
   * Whether one session's turns reach their gateway somewhere other than here.
   *
   * A session bound to no Oven runs on this machine and keeps the app's own
   * loopback endpoint, which needs no relay and no remote host.
   */
  hasGatewayEndpoint(sessionId: string): boolean {
    return this.utilityRelays !== null && this.sessions.get(sessionId) !== undefined
  }

  /**
   * Where one turn on an Oven reaches its gateway, and the closer for its relay.
   *
   * The harness on that machine posts to the Oven's own utility host; anything
   * app-owned that host cannot answer comes back here over the same relay. A
   * local session has no such address and answers null, so the caller keeps the
   * app's endpoint untouched.
   */
  async gatewayEndpoint(
    sessionId: string,
    threadId: string,
    turn: {
      turnId: string
      token: string
      grants: readonly string[]
      appBaseUrl: string
      utilities: OvenUtilityTurnUtility[]
    },
    note?: (note: string) => void
  ): Promise<{ url: string; close?: () => void } | null> {
    const session = this.sessions.get(sessionId)
    const relays = this.utilityRelays
    if (!session || !relays) return null
    const endpoint = await relays.endpoint(
      session.ovenId,
      {
        turnId: turn.turnId,
        token: turn.token,
        grants: [...turn.grants],
        utilities: turn.utilities,
        client: 'codeinoven-app',
        // The thread this turn speaks for, so the Oven keeps one live turn per
        // conversation however many times the app restarts mid-thread.
        threadId,
        // The checkout the harness works in on that machine, which is the only
        // project context its host can read.
        projectPath: session.cwd,
        sessionId
      },
      note
    )
    return { url: endpoint.url, close: endpoint.close }
  }
}

/** The pi driver surface this runtime routes a session into. */
export interface OvenPiDriver {
  setSessionStorage(sessionId: string, storage: PiCioFilesStorage | null): void
  /**
   * Bind the session id the thread already carries to the Oven's checkout.
   *
   * The record hashes the directory the harness runs in, and that turn runs on
   * the Oven: without the re-stamp the very next request rejects the id as an
   * unavailable session.
   */
  adoptSessionPath(projectPath: string, sessionId: string, title: string): Promise<void>
}

let runtime: OvenPiRuntime | null = null

/** The shared runtime, created once per Oven client (one app run has one). */
export function installOvenPiRuntime(service: OvenPiRuntimeService): OvenPiRuntime {
  if (runtime === null || runtime.service !== service) runtime = new OvenPiRuntime(service)
  return runtime
}

/** The runtime this app run shares, or null when it was never installed. */
export function ovenPiRuntime(): OvenPiRuntime | null {
  return runtime
}

/**
 * Whether one turn belongs on the Oven's pi RPC path instead of its one-shot
 * CLI path.
 *
 * Only a pi turn on a remote Oven has an RPC session to route, and only when the
 * runtime that owns those routes exists at all; every other harness keeps the
 * one-shot path it has today, and a local thread never reaches this decision.
 */
export function ovenPiTurnApplies(
  settings: Pick<ThreadSettings, 'harnessId' | 'ovenId'> | undefined,
  availability: boolean
): boolean {
  return availability && settings?.harnessId === 'pi' && isRemoteOvenId(settings.ovenId)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
