/**
 * The single owner of every local inference server process the app spawns.
 *
 * Speech cleanup and search embeddings used to each spawn and each unload their
 * own `llama-server`. Two owners of the same executable meant two idle policies,
 * two load paths, and a search sweep that kept re-arming speech's unload timer, so
 * the server never actually expired. This registry owns the process: one entry per
 * (runtime, model file, port), one in-flight launch per key, and one idle window
 * that the Local AI settings own.
 *
 * A consumer keeps only a {@link LocalAiServerHandle}. That handle answers
 * liveness instead of a private `ChildProcess`, so a server the registry unloaded
 * on its idle window reads as gone and the next request boots it again, instead
 * of a consumer holding a dead child and believing it is resident.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  DEFAULT_LOCAL_AI_UNLOAD_OPTION,
  localAiUnloadMs,
  type LocalAiRuntimeId,
  type LocalAiUnloadOption
} from '../../lib/llama-cpp'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { sharedLlamaRuntimeService } from '../speech/llama-runtime-service'
import { Logger } from '../system/logger'

/** How long a server may take to report the port it bound. */
const DEFAULT_PORT_TIMEOUT_MS = 30_000
/** How long a model may take to load before the server answers `/health`. */
const DEFAULT_HEALTH_TIMEOUT_MS = 180_000
/** Cadence of the readiness probe while a model loads. */
const HEALTH_POLL_MS = 500
/** How long a terminated server is given before the kill is escalated. */
const TERMINATE_GRACE_MS = 5_000

/** One launch request: what the server is, where it runs, and what it costs. */
export interface LocalAiServerRequest {
  runtime: LocalAiRuntimeId
  /** Absolute path of the model file the server loads. */
  modelFile: string
  /** Requested TCP port. 0 asks the operating system for a free one. */
  port: number
  executable: string
  args: readonly string[]
  cwd: string
  /** Short name for logs, e.g. `embedding` or `speech-cleanup`. */
  label: string
  /**
   * True when the caller is waiting on this model right now (a person's search,
   * an edit cleanup, an explicit warm). Only an interactive call restarts an idle
   * window on a server that is already resident; a background sweep reuses the
   * server and leaves its window running, so the model can still expire.
   */
  interactive: boolean
  /** Called once with the spawned process, for a caller that tracks pids. */
  onSpawn?: (pid: number, executable: string, cwd: string) => void
  portTimeoutMs?: number
  healthTimeoutMs?: number
  /** Endpoint the readiness wait reads. */
  healthPath?: string
}

/** A spawned server process, reduced to what the registry needs from it. */
export interface LocalAiServerProcess {
  readonly pid: number
  readonly port: number
  /** Resolves once the process has exited. */
  readonly exited: Promise<void>
  /** Ask the process to stop; the implementation escalates to a kill. */
  terminate(): void
}

/**
 * How a request becomes a running process. Separated from the registry so the
 * registry's keying, sharing, and idle policy can be tested without spawning
 * anything.
 */
export interface LocalAiProcessLauncher {
  launch(request: LocalAiServerRequest): Promise<LocalAiServerProcess>
}

/** What a consumer holds instead of a child process. */
export interface LocalAiServerHandle {
  /** Registry key: runtime, model file, and requested port. */
  readonly key: string
  /** Incremented on every launch, so a respawn is distinguishable from a reuse. */
  readonly generation: number
  readonly runtime: LocalAiRuntimeId
  readonly modelFile: string
  readonly port: number
}

/** The journal hooks the registry records app-spawned servers with. */
export interface LocalAiRegistryHost {
  registerProcess(pid: number, command: string, cwd: string): void
  unregisterProcess(pid: number): void
  /** Runs once before the first spawn, so a previous launch's orphans are reaped. */
  prepare?: () => Promise<void>
}

interface RegistryEntry {
  handle: LocalAiServerHandle
  process: LocalAiServerProcess
  idleTimer: NodeJS.Timeout | null
}

/** The key a server is shared under: same runtime, model file, and port is one server. */
export function localAiServerKey(
  request: Pick<LocalAiServerRequest, 'runtime' | 'modelFile' | 'port'>
): string {
  return `${request.runtime}\u0000${request.port}\u0000${request.modelFile}`
}

/**
 * Owns the servers: shares them per key, launches one process per key even under
 * concurrent callers, and unloads an idle server on the configured window.
 */
export class LocalAiRuntimeRegistry {
  private readonly servers = new Map<string, RegistryEntry>()
  /** Launches in flight, so two concurrent callers cannot spawn two servers. */
  private readonly launching = new Map<string, Promise<LocalAiServerHandle>>()
  /** Stops in flight, so a caller never adopts a server that is being torn down. */
  private readonly stopping = new Map<string, Promise<void>>()
  private unloadOption: LocalAiUnloadOption = DEFAULT_LOCAL_AI_UNLOAD_OPTION
  private generation = 0
  private prepared: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly launcher: LocalAiProcessLauncher,
    private readonly host: LocalAiRegistryHost
  ) {}

  /**
   * Apply the user's unload choice to every resident server. `keep` clears the
   * windows instead of arming them, and a shorter window restarts from now.
   */
  setUnloadOption(option: LocalAiUnloadOption): void {
    if (this.unloadOption === option) return
    this.unloadOption = option
    for (const entry of this.servers.values()) {
      if (option === 'keep') this.clearIdle(entry)
      else this.armIdle(entry)
    }
    Logger.dev('Local AI unload window changed', {
      option,
      servers: this.servers.size
    })
  }

  /**
   * The server for this request, launching one when nothing resident matches.
   * A resident server is reused and its idle window restarted only for an
   * interactive caller.
   */
  async ensureServer(request: LocalAiServerRequest): Promise<LocalAiServerHandle> {
    const key = localAiServerKey(request)
    for (;;) {
      const entry = this.servers.get(key)
      if (entry) {
        if (request.interactive) this.armIdle(entry)
        return entry.handle
      }
      const stopping = this.stopping.get(key)
      if (stopping) {
        await stopping
        continue
      }
      const inFlight = this.launching.get(key)
      if (inFlight) {
        const handle = await inFlight
        const started = this.servers.get(key)
        if (request.interactive && started && started.handle.generation === handle.generation) {
          this.armIdle(started)
        }
        return handle
      }
      const launch = this.start(request, key)
      this.launching.set(key, launch)
      try {
        return await launch
      } finally {
        this.launching.delete(key)
      }
    }
  }

  /** Whether the server behind this handle is still running. */
  isAlive(handle: LocalAiServerHandle): boolean {
    const entry = this.servers.get(handle.key)
    return entry !== undefined && entry.handle.generation === handle.generation
  }

  /** Stop one server now, whatever its window says. */
  async release(handle: LocalAiServerHandle): Promise<void> {
    const entry = this.servers.get(handle.key)
    if (!entry || entry.handle.generation !== handle.generation) return
    await this.stop(handle.key, entry, 'released')
  }

  /** Stop every server. Called from app quit, after the consumers are disposed. */
  async dispose(): Promise<void> {
    this.disposed = true
    const keys = [...this.servers.keys()]
    await Promise.all(
      keys.map(async (key) => {
        const entry = this.servers.get(key)
        if (entry) await this.stop(key, entry, 'shutdown')
      })
    )
  }

  private async start(request: LocalAiServerRequest, key: string): Promise<LocalAiServerHandle> {
    if (this.disposed) throw new Error('The local AI runtime registry has been disposed.')
    // A failed recovery must not block every later launch: the servers are still
    // journaled from here on, so the next launch reaps whatever this one could not.
    this.prepared ??= (this.host.prepare?.() ?? Promise.resolve()).catch((cause: unknown) => {
      Logger.error('Local AI orphan recovery failed (non-fatal)', cause)
    })
    await this.prepared
    const process = await this.launcher.launch(request)
    this.host.registerProcess(process.pid, request.executable, request.cwd)
    request.onSpawn?.(process.pid, request.executable, request.cwd)
    const entry: RegistryEntry = {
      handle: {
        key,
        generation: ++this.generation,
        runtime: request.runtime,
        modelFile: request.modelFile,
        port: process.port
      },
      process,
      idleTimer: null
    }
    this.servers.set(key, entry)
    // A launch always arms the window: a server started by a background sweep is
    // still a model holding memory nobody has asked for yet.
    this.armIdle(entry)
    void process.exited.then(() => this.onExit(key, entry))
    Logger.dev('Local AI server started', {
      label: request.label,
      runtime: request.runtime,
      model: request.modelFile,
      port: process.port,
      pid: process.pid,
      interactive: request.interactive
    })
    return entry.handle
  }

  private onExit(key: string, entry: RegistryEntry): void {
    this.clearIdle(entry)
    if (this.servers.get(key) === entry) this.servers.delete(key)
    this.host.unregisterProcess(entry.process.pid)
  }

  private async stop(key: string, entry: RegistryEntry, reason: string): Promise<void> {
    this.clearIdle(entry)
    if (this.servers.get(key) === entry) this.servers.delete(key)
    const stopping = (async (): Promise<void> => {
      entry.process.terminate()
      // The launcher escalates to a kill on its own; the wait only bounds how
      // long a teardown blocks a caller that wants the same key again.
      await Promise.race([entry.process.exited, delay(TERMINATE_GRACE_MS)])
    })()
    this.stopping.set(key, stopping)
    try {
      await stopping
    } finally {
      if (this.stopping.get(key) === stopping) this.stopping.delete(key)
    }
    Logger.dev('Local AI server stopped', {
      reason,
      port: entry.handle.port,
      pid: entry.process.pid
    })
  }

  private armIdle(entry: RegistryEntry): void {
    this.clearIdle(entry)
    const window = localAiUnloadMs(this.unloadOption)
    if (window === null) return
    const timer = setTimeout(() => {
      entry.idleTimer = null
      if (this.servers.get(entry.handle.key) !== entry) return
      Logger.dev('Local AI server unloading after its idle window', {
        port: entry.handle.port,
        window
      })
      void this.stop(entry.handle.key, entry, 'idle')
    }, window)
    timer.unref?.()
    entry.idleTimer = timer
  }

  private clearIdle(entry: RegistryEntry): void {
    if (!entry.idleTimer) return
    clearTimeout(entry.idleTimer)
    entry.idleTimer = null
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Spawn `llama-server`, wait for the port it reports on stderr, and wait for the
 * model to finish loading. Every consumer of the binary launches through here, so
 * the stderr handling, readiness wait, and shutdown escalation exist once.
 */
export class SpawnedLlamaServer implements LocalAiServerProcess {
  readonly exited: Promise<void>

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    readonly pid: number,
    readonly port: number
  ) {
    this.exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
    })
  }

  static async launch(request: LocalAiServerRequest): Promise<SpawnedLlamaServer> {
    // llama-server picks its own free TCP port with `--port 0` and reports the
    // listening URL on stderr before the model finishes loading.
    const child = spawn(request.executable, [...request.args], {
      cwd: request.cwd,
      env: buildProcessEnvironment(),
      stdio: ['ignore', 'ignore', 'pipe']
    }) as unknown as ChildProcessWithoutNullStreams
    const pid = child.pid
    if (pid === undefined) {
      child.kill('SIGKILL')
      throw new Error('llama-server could not be started.')
    }
    try {
      const port = await waitForReportedPort(
        child,
        request.portTimeoutMs ?? DEFAULT_PORT_TIMEOUT_MS
      )
      await waitForHealth(
        port,
        request.healthPath ?? '/health',
        request.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS
      )
      return new SpawnedLlamaServer(child, pid, port)
    } catch (cause) {
      // A server that never became ready is not left behind holding memory.
      terminateChild(child)
      throw cause
    }
  }

  terminate(): void {
    terminateChild(this.child)
  }
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  try {
    child.kill('SIGTERM')
  } catch {
    return
  }
  const escalate = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null) return
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone; the exit event simply arrived late.
    }
  }, TERMINATE_GRACE_MS)
  escalate.unref?.()
  child.once('exit', () => clearTimeout(escalate))
}

function waitForReportedPort(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let buffered = ''
    const finish = (failure?: Error, port?: number): void => {
      clearTimeout(timer)
      child.stderr.off('data', onData)
      child.off('error', onError)
      child.off('exit', onExit)
      if (failure) {
        child.stderr.resume()
        reject(failure)
        return
      }
      // Keep draining stderr: an unread pipe fills and blocks the server.
      child.stderr.resume()
      resolve(port ?? 0)
    }
    const onData = (chunk: string): void => {
      buffered = `${buffered}${chunk}`.slice(-4000)
      const match = /(?:http|https):\/\/[^\s]+:(\d+)/u.exec(buffered)
      const port = match?.[1] ? Number(match[1]) : 0
      if (port > 0) finish(undefined, port)
    }
    const onError = (error: Error): void => finish(error)
    const onExit = (): void => finish(new Error(buffered.trim() || 'llama-server exited early.'))
    const timer = setTimeout(
      () => finish(new Error('llama-server did not report its port.')),
      timeoutMs
    )
    timer.unref?.()
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', onData)
    child.once('error', onError)
    child.once('exit', onExit)
  })
}

async function waitForHealth(port: number, path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      if (response.ok) return
    } catch {
      // Still loading the model; retry below.
    }
    await delay(HEALTH_POLL_MS)
  }
  throw new Error('llama-server did not become healthy after loading its model.')
}

let sharedInstance: LocalAiRuntimeRegistry | null = null

/**
 * The registry every local-inference consumer shares. One instance, because it
 * owns one process per key and the app's only copy of their idle windows.
 */
export function sharedLocalAiRuntimeRegistry(): LocalAiRuntimeRegistry {
  sharedInstance ??= new LocalAiRuntimeRegistry(
    { launch: (request) => SpawnedLlamaServer.launch(request) },
    {
      registerProcess: (pid, command, cwd) =>
        sharedLlamaRuntimeService().registerServerProcess(pid, command, cwd),
      unregisterProcess: (pid) => sharedLlamaRuntimeService().unregisterServerProcess(pid),
      prepare: () =>
        sharedLlamaRuntimeService()
          .recoverOrphans()
          .then(() => undefined)
    }
  )
  return sharedInstance
}
