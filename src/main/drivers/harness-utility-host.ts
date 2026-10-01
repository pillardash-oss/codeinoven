import { app, utilityProcess, type UtilityProcess } from 'electron'
import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import type { PreparedHarnessInvocation } from './harness-runtime'
import { Logger } from '../system/logger'

/**
 * Electron-standard launcher for the bundled Pi harness.
 *
 * Spawning `process.execPath` (Electron run as Node) as a plain child registers
 * a standalone LaunchServices app on macOS for every invocation, and macOS then
 * shows a bouncing terminal-like Dock icon for each helper. The fix is to run
 * the harness entrypoint **in-process** inside Electron's own managed
 * `utilityProcess` helpers: those children are OS-managed app helpers and never
 * surface as separate apps, windows, or Dock entries.
 *
 * Native CLI installs and WSL invocations run plain binaries that LaunchServices
 * never registers, so they keep using the direct `spawn` path.
 */

/** Disk location of the bridge module shipped beside the bundled harness. */
export function utilityBridgePath(): string | null {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'harnesses/utility-bridge.cjs')
    : join(app.getAppPath(), 'resources/harnesses/utility-bridge.cjs')
  return existsSync(candidate) ? candidate : null
}

/**
 * The utility helper itself must launch as a normal Electron helper, so its
 * env cannot carry `ELECTRON_RUN_AS_NODE` — Electron only allows node-mode via
 * helper args otherwise the helper binary mis-parses its own Chromium flags
 * (`bad option: --type=utility`). The harness module receives the full env
 * through the `run` message instead.
 */
function cleanHelperEnvironment(harnessEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const helperEnv = { ...harnessEnv }
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete helperEnv[key]
  return helperEnv
}

interface HarnessRunRequest {
  modulePath: string
  argv: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/**
 * A harness child whose body runs inside an Electron utilityProcess. Presents
 * the `ChildProcess` surface the app already relies on (pid, streams, exit
 * events, kill, exit/signal state) while virtual stdio travels across the
 * postMessage channel between the utility helper and the main process.
 */
class UtilityHostChild extends ChildProcess {
  override readonly stdin: PassThrough = new PassThrough()
  override readonly stdout: PassThrough = new PassThrough()
  override readonly stderr: PassThrough = new PassThrough()
  override pid: number
  override killed = false
  override exitCode: number | null = null
  override signalCode: NodeJS.Signals | null = null
  override spawnargs: string[]
  override spawnfile: string

  private readonly helper: UtilityProcess
  private exitAccepted = false
  /** Whether a positive pid has already been published (and `spawn` emitted). */
  private spawnAnnounced = false

  constructor(helper: UtilityProcess, request: HarnessRunRequest, bridgePid: number) {
    super()
    this.helper = helper
    // Electron leaves `helper.pid` undefined until the helper has spawned, which
    // is after this constructor runs; the bridge reports the real pid back as its
    // first message (see `resolvePid`). A non-zero value here only happens on the
    // rare occasion the pid is already known, which lets the driver register
    // synchronously.
    this.pid = bridgePid > 0 ? bridgePid : 0
    this.spawnAnnounced = this.pid > 0
    this.spawnfile = request.argv[0] ?? 'utility'
    this.spawnargs = request.argv.slice()

    this.stdin.on('data', (chunk: Buffer) => this.safePost({ t: 'stdin-data', b64: chunk.toString('base64') }))
    this.stdin.on('end', () => this.safePost({ t: 'stdin-end' }))

    helper.on('message', (message: unknown) => this.consumeHelperMessage(message))
    helper.on('exit', (code: number) => this.acceptExit(code, null))
    helper.postMessage({ t: 'run', ...request })
  }

  /** Stop the harness by terminating its helper; the exit event follows. */
  override kill(): boolean {
    this.killed = true
    const delivered = this.helper.kill()
    if (!delivered && !this.exitAccepted) {
      this.acceptExit(null, 'SIGTERM')
    }
    return delivered
  }

  private acceptExit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exitAccepted) return
    this.exitAccepted = true
    this.exitCode = code ?? null
    this.signalCode = signal ?? null
    this.stdout.push(null)
    this.stderr.push(null)
    this.emit('exit', code, signal)
  }

  private safePost(message: Record<string, unknown>): void {
    try {
      this.helper.postMessage(message)
    } catch (error) {
      Logger.dev('[utility-host] postMessage delivery failed:', error)
    }
  }

  private consumeHelperMessage(message: unknown): void {
    if (!message || typeof message !== 'object') return
    const record = message as Record<string, unknown>
    if (record['t'] === 'pid') {
      this.resolvePid(record['pid'])
      return
    }
    if (record['t'] === 'data') {
      const stream = record['stream'] === 'err' ? this.stderr : this.stdout
      const baseline = record['b64']
      if (typeof baseline === 'string') stream.push(Buffer.from(baseline, 'base64'))
      return
    }
    if (record['t'] === 'error') {
      const detail = typeof record['message'] === 'string' ? record['message'] : 'Unknown utility bridge error'
      this.stderr.push(Buffer.from(`${detail}\n`))
      return
    }
    if (record['t'] === 'exit' && typeof record['code'] === 'number') {
      this.acceptExit(record['code'], null)
    }
  }

  /**
   * Publish the helper's OS pid once it is known and emit `spawn` so a process
   * observer that could not read it synchronously can attach the harness root.
   */
  private resolvePid(pid: unknown): void {
    if (this.spawnAnnounced) return
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return
    this.pid = pid
    this.spawnAnnounced = true
    this.emit('spawn')
  }
}

/** Spawn a bundled harness module in-process inside an Electron utility helper. */
export function spawnInUtilityHost(
  prepared: Pick<PreparedHarnessInvocation, 'command' | 'args' | 'cwd' | 'env' | 'shell'>
): ChildProcess {
  const bridge = utilityBridgePath()
  if (!bridge) {
    return spawn(prepared.command, prepared.args, {
      ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
      env: prepared.env,
      shell: prepared.shell,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  }
  const helper = utilityProcess.fork(bridge, [], {
    serviceName: 'bundled-harness',
    env: cleanHelperEnvironment(prepared.env)
  })
  const request: HarnessRunRequest = {
    modulePath: prepared.args[0] ?? 'harness',
    argv: [process.execPath, ...prepared.args],
    ...(prepared.cwd ? { cwd: prepared.cwd } : {}),
    env: prepared.env
  }
  return new UtilityHostChild(helper, request, helper.pid ?? 0)
}
