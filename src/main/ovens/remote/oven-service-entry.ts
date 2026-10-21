/** Standalone Node service. No Electron, desktop paths, or app-owned process markers. */
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer, connect, type Socket } from 'node:net'
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  chmod,
  readdir,
  statfs,
  rm,
  writeFile
} from 'node:fs/promises'
import { availableParallelism, hostname, homedir, totalmem, tmpdir, uptime } from 'node:os'
import { createInterface } from 'node:readline'
import { join, isAbsolute } from 'node:path'
import { harnessLaunchSpec, launchSpec } from './oven-windows-command'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { once } from 'node:events'
import type { OvenHarnessInventoryItem, OvenProbe, OvenRun, OvenRunEvent } from '../../../lib/ovens'
import { ovenHarnessIdForCommand } from '../../../lib/ovens'
import { listHarnesses } from '../../agents/harness-registry'
import { OPENCODE_COMMAND_ALIASES } from '../../../lib/opencode-version'
import { OVEN_DATA_DIRECTORY, OVEN_LEGACY_DATA_DIRECTORY } from './oven-root-paths'
import { isCurrentServiceAnswer } from '../oven-service-bundle'
import { OVEN_NPM_PREFIX } from '../oven-harness-paths'
import {
  NON_INTERACTIVE_WSL_DISTRIBUTIONS,
  WSL_DISCOVERY_SCRIPT,
  decodeWslOutput,
  windowsWslExecutablePath,
  wslDistributionFromUncPath,
  wslRunArgv
} from '../oven-wsl'
import { ovenRootOperation } from './oven-root-operations'
import { ovenWorkspace } from './oven-workspace'
import {
  WINDOWS_LAUNCHER_FILE,
  enableWindowsTask,
  legacyWindowsLauncherFile,
  registerWindowsTask,
  runWindowsTask,
  windowsLauncherScript,
  windowsTaskAction
} from './oven-windows-task'
import {
  installTermuxSupervision,
  startSystemdSupervision,
  startTermuxSupervision,
  supervisionTarget,
  type OvenSupervisionInput,
  type SupervisionCommandRunner
} from './oven-service-supervision'

const PROTOCOL = 1
const revision = process.env['CODEINOVEN_OVEN_REVISION'] ?? 'development'
/**
 * The harnesses an oven can host, taken from the one canonical registry and
 * narrowed to the commands the app is allowed to run remotely. Deriving this
 * list instead of restating it means a harness added to the registry cannot
 * silently become Local-only.
 */
const HARNESSES: readonly { id: string; command: string; versionArgs: readonly string[] }[] =
  listHarnesses()
    .filter((harness) => ovenHarnessIdForCommand(harness.command) === harness.id)
    .map((harness) => ({
      id: harness.id,
      command: harness.command,
      versionArgs: harness.versionArgs
    }))
/** Aliases a harness may also be installed under, accepted for starting runs. */
const COMMANDS = [
  ...new Set([...HARNESSES.map((harness) => harness.command), ...OPENCODE_COMMAND_ALIASES])
]
/** Version output is informational; a slow harness must not stall a probe. */
const VERSION_TIMEOUT_MS = 4_000
const INVENTORY_TTL_MS = 10 * 60_000
const INVENTORY_REFRESH_CONCURRENCY = 3
type InventoryEnvironment = NonNullable<OvenHarnessInventoryItem['environment']>

const versionCache = new Map<
  string,
  {
    path: string | null
    version: string | null
    health: string
    issueCategory?: string
    environment?: InventoryEnvironment
    wslDistribution?: string
    checkedAt: number
  }
>()
const root = process.env['CODEINOVEN_OVEN_DATA_ROOT'] ?? join(homedir(), OVEN_DATA_DIRECTORY)
/** Where earlier releases kept the same state, before it moved into the app namespace. */
const legacyRoot = join(homedir(), OVEN_LEGACY_DATA_DIRECTORY)
/**
 * Directories harnesses install into that a non-interactive SSH PATH omits.
 *
 * The app's managed npm prefix is one. The native one-line installers are the
 * other: Antigravity's and Muse Code's Unix scripts write to `~/.local/bin`, and
 * their PowerShell scripts write under the user's LocalAppData, which is where
 * Muse's `.cmd` shim and Antigravity's `agy.exe` end up.
 */
function harnessInstallDirs(): string[] {
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA']
    if (!local) return []
    return [join(local, 'agy', 'bin'), join(local, 'Programs', 'muse')]
  }
  return [join(homedir(), OVEN_NPM_PREFIX, 'bin'), join(homedir(), '.local', 'bin')]
}

const installDirs = harnessInstallDirs()
if (installDirs.length > 0) {
  const separator = process.platform === 'win32' ? ';' : ':'
  process.env['PATH'] = `${installDirs.join(separator)}${separator}${process.env['PATH'] ?? ''}`
}
if (process.platform !== 'win32')
  process.env['npm_config_prefix'] = join(homedir(), OVEN_NPM_PREFIX)
/**
 * Where clients reach the running service.
 *
 * POSIX binds a unix socket file under the data root. Windows cannot: the same
 * call creates a named pipe there, so the path is the pipe name itself and no
 * filesystem permission call below can apply to it.
 *
 * A unix socket path is capped by the platform (104 bytes on macOS, 108 on
 * Linux). A data root nested deeply enough to exceed that still needs a
 * reachable service, so the socket falls back to a short path keyed by the root
 * instead of failing to bind.
 */
const MAX_POSIX_SOCKET_PATH = 100
const socketPath =
  process.platform === 'win32'
    ? `\\\\.\\pipe\\codeinoven-oven-${createHash('sha256').update(root).digest('hex').slice(0, 16)}`
    : posixSocketPath()

function posixSocketPath(): string {
  const preferred = join(root, 'service.sock')
  if (Buffer.byteLength(preferred) <= MAX_POSIX_SOCKET_PATH) return preferred
  return join(
    tmpdir(),
    `codeinoven-oven-${createHash('sha256').update(root).digest('hex').slice(0, 16)}.sock`
  )
}
const lockPath = join(root, 'service.pid')
/**
 * The platform this Oven reports to the app.
 *
 * Termux on Android is a Linux userspace with an ordinary POSIX shell, npm, and
 * the same command set as any other Oven; only the runtime's own name differs.
 * The app plans and quotes every command from this value, so reporting the Linux
 * family it actually is keeps the Oven out of the unsupported-platform path
 * without a separate Android branch in every setup rule. Behaviour elsewhere in
 * this file still reads `process.platform`, which stays the runtime's own truth.
 */
const reportedPlatform = process.platform === 'android' ? 'linux' : process.platform

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Ask the service one question, treating "nothing is listening" as an answer too. */
async function answerOrNull(data: string): Promise<string | null> {
  try {
    return await request(data)
  } catch {
    return null
  }
}

/** How many runs a service says it is working on, from any answer it gave. */
function activeRunsIn(answer: string | null): number {
  if (!answer) return 0
  try {
    const parsed = JSON.parse(answer.replace(/^\uFEFF/u, '')) as {
      value?: { activeRuns?: unknown }
    }
    return typeof parsed.value?.activeRuns === 'number' ? parsed.value.activeRuns : 0
  } catch {
    return 0
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Wait until nothing answers on this data root, so a new daemon can bind. */
async function waitForNoAnswer(): Promise<void> {
  const data = `${JSON.stringify({ method: 'probe', protocolVersion: PROTOCOL })}\n`
  for (let attempt = 0; attempt < 40; attempt++) {
    await sleep(100)
    if ((await answerOrNull(data)) === null) return
  }
}

/** Wait for a healthy answer from the revision that was just installed. */
async function waitForCurrentService(data: string): Promise<string | null> {
  for (let attempt = 0; attempt < 50; attempt++) {
    await sleep(100)
    const answer = await answerOrNull(data)
    if (answer && isCurrentServiceAnswer(answer, revision)) return answer
  }
  return null
}

/**
 * Remove the service process that is standing in the way, with its leftovers.
 *
 * The lock and the socket belong to the daemon that is gone, so they are
 * removed with it instead of being left for the next start to trip over. This
 * is the escape hatch a replacement needs when the previous install cannot be
 * asked to leave: a bundle that predates the shutdown request, or one whose
 * process outlived it.
 */
async function forceStopDaemon(): Promise<void> {
  const pid = Number(await readFile(lockPath, 'utf8').catch(() => ''))
  if (Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      /* It exited between the read and the signal. */
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(100)
      if (!processAlive(pid)) break
    }
    if (processAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* It exited between the check and the signal. */
      }
      await sleep(250)
    }
  }
  await unlink(lockPath).catch(() => undefined)
  await unlink(socketPath).catch(() => undefined)
}
const jobs = new Map<string, Job>()
let shutDownServer: (() => void) | undefined
let requestTail: Promise<unknown> = Promise.resolve()
const MAX_REQUEST = 1024 * 1024
const MAX_RUNS = 64
const MAX_ACTIVE = 4
const MAX_JOURNAL = 64 * 1024 * 1024
/** The requests that address one run, and so need a run id before anything else. */
const RUN_REQUEST_METHODS = new Set(['events', 'stop', 'write', 'remove'])

function stopChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      /* Process group already exited. */
    }
  }
  child.kill(signal)
}

interface Job {
  run: OvenRun
  child?: ChildProcessWithoutNullStreams
  sequence: number
  bytes: number
  tail: Promise<void>
  queuedBytes: number
  offsets: Map<number, number>
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected a request object.')
  return value as Record<string, unknown>
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(value))
    throw new Error('Invalid run ID.')
  return value
}

async function atomicState(run: OvenRun): Promise<void> {
  const path = join(root, 'runs', `${run.id}.json`)
  const file = await open(`${path}.next`, 'w', 0o600)
  try {
    await file.writeFile(JSON.stringify(run))
    await file.sync()
  } finally {
    await file.close()
  }
  await rename(`${path}.next`, path)
}

async function executable(command: string): Promise<string | null> {
  const separator = process.platform === 'win32' ? ';' : ':'
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const directory of (process.env['PATH'] ?? '').split(separator).filter(Boolean)) {
    for (const extension of extensions) {
      const path = join(directory, command + extension.toLowerCase())
      try {
        await access(path, constants.X_OK)
        return path
      } catch {
        /* Continue PATH search. */
      }
    }
  }
  return null
}

/* ----------------------------------------------------------- WSL on Windows */

/** WSL cold starts are slow, and a distribution set rarely changes. */
const WSL_CACHE_TTL_MS = 5 * 60_000
const WSL_LIST_TIMEOUT_MS = 20_000
const WSL_COMMAND_TIMEOUT_MS = 30_000

function runCapture(
  program: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise((resolve) => {
    let settled = false
    const chunks: Buffer[] = []
    const child = spawn(program, [...args], { stdio: ['ignore', 'pipe', 'ignore'] })
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout: Buffer.concat(chunks) })
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(null)
    }, timeoutMs)
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk))
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code))
  })
}

interface WslState {
  executable?: string
  distributions: string[]
}

let wslCache: { value: WslState; checkedAt: number } | undefined

/**
 * The distributions this Windows Oven can reach.
 *
 * A Windows Oven with no WSL, or WSL with only container distributions, answers
 * with an empty list, which is what tells every caller to stay on the host side.
 */
async function wslState(): Promise<WslState> {
  if (wslCache && Date.now() - wslCache.checkedAt < WSL_CACHE_TTL_MS) return wslCache.value
  const executable = windowsWslExecutablePath(process.platform, process.env)
  if (!executable) {
    wslCache = { value: { distributions: [] }, checkedAt: Date.now() }
    return wslCache.value
  }
  const result = await runCapture(executable, ['--list', '--quiet'], WSL_LIST_TIMEOUT_MS)
  const distributions =
    result.code === 0
      ? [
          ...new Set(
            decodeWslOutput(result.stdout)
              .split(/\r?\n/u)
              .map((value) => value.replace(/\0/gu, '').trim())
              .filter(
                (value) =>
                  Boolean(value) &&
                  !NON_INTERACTIVE_WSL_DISTRIBUTIONS.has(value.toLocaleLowerCase('en-US'))
              )
          )
        ]
      : []
  wslCache = { value: { executable, distributions }, checkedAt: Date.now() }
  return wslCache.value
}

/** Resolve a set of commands inside one distribution, in a single WSL call. */
async function discoverInDistribution(
  executable: string,
  distribution: string,
  commands: readonly string[]
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  if (commands.length === 0) return found
  const result = await runCapture(
    executable,
    ['--distribution', distribution, '--', 'sh', '-lc', WSL_DISCOVERY_SCRIPT, 'cio', ...commands],
    WSL_COMMAND_TIMEOUT_MS
  )
  if (result.code !== 0) return found
  for (const line of decodeWslOutput(result.stdout).split(/\r?\n/u)) {
    const separator = line.indexOf('\t')
    if (separator <= 0) continue
    const command = line.slice(0, separator).trim()
    const path = line.slice(separator + 1).trim()
    if (commands.includes(command) && path.startsWith('/')) found.set(command, path)
  }
  return found
}

/**
 * Resolve commands the Windows host does not have inside its distributions.
 *
 * The host wins whenever it has the command: a harness the user installed for
 * Windows stays the one the app drives. WSL only answers for what the host
 * lacks, which is exactly the install the app could not see before.
 */
async function discoverWslHarnesses(
  commands: readonly string[]
): Promise<Map<string, { path: string; distribution: string }>> {
  const resolved = new Map<string, { path: string; distribution: string }>()
  if (process.platform !== 'win32' || commands.length === 0) return resolved
  const wsl = await wslState()
  if (!wsl.executable) return resolved
  for (const distribution of wsl.distributions) {
    const pending = commands.filter((command) => !resolved.has(command))
    if (pending.length === 0) break
    for (const [command, path] of await discoverInDistribution(
      wsl.executable,
      distribution,
      pending
    ))
      resolved.set(command, { path, distribution })
  }
  return resolved
}

/** Run one harness inside its distribution to read the version it reports. */
async function wslHarnessVersion(
  distribution: string,
  path: string,
  versionArgs: readonly string[]
): Promise<string | null> {
  const wsl = await wslState()
  if (!wsl.executable) return null
  const result = await runCapture(
    wsl.executable,
    ['--distribution', distribution, '--', 'sh', '-lc', 'exec "$0" "$@"', path, ...versionArgs],
    VERSION_TIMEOUT_MS
  )
  if (result.code !== 0) return null
  return firstVersionLine(decodeWslOutput(result.stdout))
}

/**
 * Resolve one command for a run: the host first, then each distribution.
 *
 * The program to spawn travels with the answer, so a harness found in WSL is
 * launched through the same `wsl.exe` it was found with.
 */
async function resolveHarnessForRun(
  command: string,
  cwd: string
): Promise<{ program: string; path: string; distribution?: string } | null> {
  const host = await executable(command)
  if (host) return { program: host, path: host }
  const wsl = await wslState()
  if (!wsl.executable) return null
  // A workspace opened through a distribution's own UNC root belongs to that
  // distribution, so it is tried before the default one.
  const preferred = wslDistributionFromUncPath(cwd)
  const ordered = preferred
    ? [
        preferred,
        ...wsl.distributions.filter(
          (distribution) =>
            distribution.toLocaleLowerCase('en-US') !== preferred.toLocaleLowerCase('en-US')
        )
      ]
    : wsl.distributions
  for (const distribution of ordered) {
    const found = await discoverInDistribution(wsl.executable, distribution, [command])
    const path = found.get(command)
    if (path) return { program: wsl.executable, path, distribution }
  }
  return null
}

/** The first non-empty line a harness printed, shortened to one caption. */
function firstVersionLine(output: string): string | null {
  const line = output
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .find(Boolean)
  return line ? line.slice(0, 200) : null
}

/** Run one harness version command, bounded so a hung binary cannot stall a probe. */
function harnessVersion(path: string, versionArgs: readonly string[]): Promise<string | null> {
  const spec = launchSpec(path, versionArgs)
  let child: ChildProcess
  try {
    child = spawn(spec.command, spec.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      ...(spec.verbatimArguments ? { windowsVerbatimArguments: true } : {})
    })
  } catch {
    // A harness the platform refuses to start is a harness with no version, not a
    // failed probe: npm shims are `.cmd` files that only `cmd.exe` can launch, and
    // a refused spawn used to fail the whole inventory with a bare `spawn EINVAL`.
    return Promise.resolve(null)
  }
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill('SIGKILL')
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), VERSION_TIMEOUT_MS)
    const capture = (chunk: Buffer): void => {
      if (output.length < 4096) output += chunk.toString('utf8')
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('error', () => finish(null))
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(firstVersionLine(output))
    })
  })
}

/**
 * Inventory every hosted harness.
 *
 * The desktop app drives `harness:install`, so installed versions are the only
 * thing an oven can know on its own; latest versions and update availability are
 * resolved by the client. The cache keeps a repeated probe cheap: an oven that
 * was just inventoried answers from memory, and the desktop asks for a refresh
 * only when it wants fresh versions.
 */
async function probeInventory(force = false): Promise<NonNullable<OvenProbe['inventory']>> {
  const inventory: NonNullable<OvenProbe['inventory']> = []
  const needsResolve =
    force ||
    HARNESSES.some((harness) => {
      const cached = versionCache.get(harness.id)
      return !cached || Date.now() - cached.checkedAt >= INVENTORY_TTL_MS
    })
  // The host PATH scan is cheap; a WSL pass is not, so it runs only when a
  // harness actually needs resolving, and only for what the host does not have.
  const hostPaths = new Map<string, string>()
  let wslPaths = new Map<string, { path: string; distribution: string }>()
  if (needsResolve) {
    for (const harness of HARNESSES) {
      const path = await executable(harness.command)
      if (path) hostPaths.set(harness.command, path)
    }
    wslPaths = await discoverWslHarnesses(
      HARNESSES.map((harness) => harness.command).filter((command) => !hostPaths.has(command))
    )
  }
  let cursor = 0
  const workers = Array.from(
    { length: Math.min(INVENTORY_REFRESH_CONCURRENCY, HARNESSES.length) },
    async () => {
      for (;;) {
        const harness = HARNESSES[cursor++]
        if (!harness) return
        const cached = versionCache.get(harness.id)
        if (!force && cached && Date.now() - cached.checkedAt < INVENTORY_TTL_MS) {
          inventory.push({
            harnessId: harness.id,
            command: harness.command,
            executablePath: cached.path,
            installedVersion: cached.version,
            health: cached.health as NonNullable<OvenProbe['inventory']>[number]['health'],
            ...(cached.issueCategory
              ? {
                  issueCategory: cached.issueCategory as NonNullable<
                    OvenProbe['inventory']
                  >[number]['issueCategory']
                }
              : {}),
            ...(cached.environment ? { environment: cached.environment } : {}),
            ...(cached.wslDistribution ? { wslDistribution: cached.wslDistribution } : {}),
            updateAvailable: false,
            checkedAt: cached.checkedAt,
            cached: true
          })
          continue
        }
        const hostPath = hostPaths.get(harness.command)
        const wslHit = hostPath ? undefined : wslPaths.get(harness.command)
        const path = hostPath ?? wslHit?.path ?? null
        const distribution = hostPath ? undefined : wslHit?.distribution
        const version = distribution
          ? path
            ? await wslHarnessVersion(distribution, path, harness.versionArgs)
            : null
          : path
            ? await harnessVersion(path, harness.versionArgs)
            : null
        const health = !path ? 'missing' : version ? 'healthy' : 'broken'
        const issueCategory = !path ? 'not-installed' : version ? undefined : 'broken-executable'
        const entry = {
          path,
          version,
          health,
          issueCategory,
          ...(distribution ? { environment: 'wsl' as const, wslDistribution: distribution } : {}),
          checkedAt: Date.now()
        }
        versionCache.set(harness.id, entry)
        inventory.push({
          harnessId: harness.id,
          command: harness.command,
          executablePath: path,
          installedVersion: version,
          health,
          ...(issueCategory ? { issueCategory } : {}),
          ...(distribution ? { environment: 'wsl' as const, wslDistribution: distribution } : {}),
          updateAvailable: false,
          checkedAt: entry.checkedAt
        })
      }
    }
  )
  await Promise.all(workers)
  inventory.sort((left, right) => left.harnessId.localeCompare(right.harnessId))
  return inventory
}

async function probe(refresh = false): Promise<OvenProbe> {
  const inventory = await probeInventory(refresh)
  const inventoryByCommand = new Map(inventory.map((item) => [item.command, item.executablePath]))
  const harnesses: OvenProbe['harnesses'] = COMMANDS.map((command) => ({
    command,
    path: inventoryByCommand.get(command) ?? null
  }))
  const home = homedir()
  const disk = await statfs(home)
  return {
    protocolVersion: PROTOCOL,
    serviceRevision: revision,
    platform: reportedPlatform,
    architecture: process.arch,
    home,
    nodeVersion: process.versions.node,
    // The service reports the zone its own process runs on, which is the Oven's
    // system zone and always an IANA id, even where the platform names its own.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    specs: {
      hostname: hostname(),
      platform: reportedPlatform,
      architecture: process.arch,
      cpuCount: availableParallelism(),
      memoryBytes: totalmem(),
      diskBytes: disk.blocks * disk.bsize,
      diskAvailableBytes: disk.bavail * disk.bsize,
      nodeVersion: process.versions.node,
      uptimeSeconds: Math.round(uptime())
    },
    harnesses,
    activeRuns: [...jobs.values()].filter((job) => job.run.status === 'running').length,
    inventory,
    wslDistributions: (await wslState()).distributions
  }
}
function journal(job: Job, stream: OvenRunEvent['stream'], text: string): void {
  const event: OvenRunEvent = { sequence: ++job.sequence, stream, text }
  const line = `${JSON.stringify(event)}\n`
  const size = Buffer.byteLength(line)
  if (job.bytes + size > MAX_JOURNAL || job.queuedBytes + size > MAX_REQUEST) {
    job.run.status = 'failed'
    if (job.child) stopChild(job.child, 'SIGTERM')
    return
  }
  job.bytes += size
  job.queuedBytes += size
  job.tail = job.tail
    .then(async () => {
      const file = await open(join(root, 'runs', `${job.run.id}.jsonl`), 'a', 0o600)
      try {
        await file.writeFile(line)
      } finally {
        await file.close()
        job.queuedBytes -= size
      }
    })
    .catch(() => {
      job.run.status = 'failed'
      job.child?.kill('SIGTERM')
    })
}

async function start(raw: unknown): Promise<OvenRun> {
  const value = record(raw)
  const runId = id(value.id)
  const prior = jobs.get(runId)
  if (prior) return prior.run
  if (jobs.size >= MAX_RUNS)
    throw new Error(
      'The Oven has reached its 64-run retention limit. Remove completed runs before starting another.'
    )
  if ([...jobs.values()].filter((job) => job.run.status === 'running').length >= MAX_ACTIVE)
    throw new Error('This Oven already has four active runs.')
  if (typeof value.command !== 'string' || !COMMANDS.includes(value.command))
    throw new Error('Unknown harness command.')
  if (
    !Array.isArray(value.args) ||
    value.args.length > 256 ||
    !value.args.every(
      (arg) => typeof arg === 'string' && arg.length <= 256_000 && !arg.includes('\0')
    )
  )
    throw new Error('Invalid harness arguments.')
  if (typeof value.cwd !== 'string' || !isAbsolute(value.cwd) || value.cwd.includes('\0'))
    throw new Error('Choose an absolute remote workspace path.')
  const resolved = await resolveHarnessForRun(value.command, value.cwd)
  if (!resolved) throw new Error('This harness is not installed on the Oven.')
  const environment = value.environment === undefined ? {} : record(value.environment)
  // Remote PATH/HOME remain remote. Account homes may be passed explicitly.
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, entry] of Object.entries(environment)) {
    if (
      !/^[A-Z_][A-Z0-9_]*$/u.test(key) ||
      typeof entry !== 'string' ||
      entry.length > 32_768 ||
      entry.includes('\0') ||
      ['PATH', 'HOME', 'LD_PRELOAD', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'].includes(key)
    )
      throw new Error('Invalid remote environment override.')
    env[key] = entry
  }
  const input = value.input === undefined ? '' : value.input
  if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_REQUEST)
    throw new Error('Invalid harness input.')
  const run: OvenRun = {
    id: runId,
    command: value.command,
    cwd: value.cwd,
    status: 'running',
    createdAt: Date.now()
  }
  const job: Job = {
    run,
    sequence: 0,
    bytes: 0,
    queuedBytes: 0,
    tail: Promise.resolve(),
    offsets: new Map([[0, 0]])
  }
  jobs.set(runId, job)
  try {
    await atomicState(run)
    // The daemon owns this child. SSH disconnect and desktop exit never kill it.
    // A harness that lives in a distribution runs through `wsl.exe`. Its path
    // and arguments cross as positional parameters, so a prompt or a path that
    // contains quotes arrives exactly as the caller sent it.
    const spawnArgs = resolved.distribution
      ? wslRunArgv(resolved.distribution, resolved.path, value.args as string[], run.cwd)
      : (value.args as string[])
    const spec = resolved.distribution
      ? { command: resolved.program, args: spawnArgs, verbatimArguments: false }
      : await harnessLaunchSpec(resolved.program, spawnArgs)
    const child = spawn(spec.command, spec.args, {
      cwd: run.cwd,
      env,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: spec.verbatimArguments,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    job.child = child
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (text: string) => journal(job, 'stdout', text))
    child.stderr.on('data', (text: string) => journal(job, 'stderr', text))
    child.stdin.on('error', () => undefined)
    child.on('error', () => {
      job.run.status = 'failed'
    })
    child.on('close', (code) => {
      if (job.run.status === 'running') job.run.status = code === 0 ? 'completed' : 'failed'
      job.run.exitCode = code
      job.run.finishedAt = Date.now()
      delete job.child
      journal(job, 'exit', JSON.stringify({ code, status: job.run.status }))
      job.tail = job.tail.then(() => atomicState(job.run)).catch(() => undefined)
    })
    if (input) child.stdin.write(input)
    if (value.closeInput === true) child.stdin.end()
    return run
  } catch (error) {
    jobs.delete(runId)
    throw error
  }
}

async function events(job: Job, after: unknown): Promise<{ run: OvenRun; events: OvenRunEvent[] }> {
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0)
    throw new Error('Invalid event cursor.')
  await job.tail
  const result: OvenRunEvent[] = []
  let bytes = 0
  let offset = job.offsets.get(after) ?? 0
  try {
    const file = await open(join(root, 'runs', `${job.run.id}.jsonl`), 'r')
    try {
      // Stream from disk; never load a multi-megabyte transcript into memory.
      for await (const line of file.readLines({ start: offset })) {
        offset += Buffer.byteLength(line) + 1
        const event = JSON.parse(line) as OvenRunEvent
        if (event.sequence <= after) continue
        result.push(event)
        job.offsets.set(event.sequence, offset)
        if (job.offsets.size > 1024) {
          const oldest = job.offsets.keys().next().value
          if (oldest !== undefined) job.offsets.delete(oldest)
        }
        bytes += Buffer.byteLength(line)
        if (result.length >= 128 || bytes >= 256 * 1024) break
      }
    } finally {
      await file.close().catch(() => undefined)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return { run: job.run, events: result }
}

async function dispatch(raw: unknown): Promise<unknown> {
  const request = record(raw)
  if (request.protocolVersion !== PROTOCOL) throw new Error('Oven protocol version mismatch.')
  if (request.method === 'probe') return probe(request.refresh === true)
  if (request.method === 'runs') return [...jobs.values()].map((job) => job.run)
  if (request.method === 'workspace') return ovenWorkspace(request.input)
  if (request.method === 'shutdown') {
    if ([...jobs.values()].some((job) => job.child))
      throw new Error('Finish or stop active runs before updating the Oven service.')
    setTimeout(() => shutDownServer?.(), 100).unref()
    return null
  }
  if (request.method === 'start') return start(request.input)
  // A channel opened by an earlier bundle forwards file work here instead of
  // answering it in its own process. Looking it up as a run made that answer
  // "Invalid run ID.", which named nothing and sent people after a run id that
  // was never involved, so the daemon answers the request the same way the
  // channel does while the app replaces that bundle.
  if (request.method === 'root-operation') return ovenRootOperation(request.input)
  const method = String(request.method)
  if (!RUN_REQUEST_METHODS.has(method))
    throw new Error(`Unknown Oven request method: ${method}. Install the current Oven service.`)
  const job = jobs.get(id(request.runId))
  if (!job) throw new Error('The remote run does not exist.')
  if (request.method === 'events') return events(job, request.after)
  if (request.method === 'stop') {
    if (job.child) {
      job.run.status = 'stopped'
      stopChild(job.child, 'SIGTERM')
      const child = job.child
      const timer = setTimeout(() => {
        if (job.child === child) stopChild(child, 'SIGKILL')
      }, 5000)
      timer.unref()
    }
    return null
  }
  if (request.method === 'write') {
    if (!job.child || job.run.status !== 'running')
      throw new Error('The remote run is no longer working.')
    if (typeof request.input !== 'string' || Buffer.byteLength(request.input) > MAX_REQUEST)
      throw new Error('Invalid harness input.')
    if (!job.child.stdin.write(request.input)) await once(job.child.stdin, 'drain')
    if (request.closeInput === true) job.child.stdin.end()
    return null
  }
  if (request.method === 'remove') {
    if (job.child) throw new Error('Stop the remote run before removing it.')
    await job.tail
    await unlink(join(root, 'runs', `${job.run.id}.json`))
    await unlink(join(root, 'runs', `${job.run.id}.jsonl`)).catch(() => undefined)
    jobs.delete(job.run.id)
    return null
  }
  throw new Error('Unknown Oven request.')
}

function receive(socket: Socket, handle: (data: string) => Promise<string>): void {
  let buffer = ''
  let bytes = 0
  const timer = setTimeout(() => socket.destroy(), 30_000)
  socket.setEncoding('utf8')
  socket.on('error', () => undefined)
  socket.on('close', () => clearTimeout(timer))
  socket.on('data', (chunk: string) => {
    bytes += Buffer.byteLength(chunk)
    if (bytes > MAX_REQUEST) {
      socket.destroy()
      return
    }
    buffer += chunk
    const end = buffer.indexOf('\n')
    if (end < 0) return
    socket.pause()
    void handle(buffer.slice(0, end))
      .then((response) => socket.end(`${response}\n`))
      .catch(() => socket.end('{"ok":false,"error":"Oven request failed."}\n'))
  })
}

/**
 * Move a data root left by an earlier release into its current home.
 *
 * Only entries the new root does not already have are moved, so an interrupted
 * migration can run again and an existing entry is never overwritten. The two
 * runtime artifacts of a possibly still-running earlier daemon, `service.sock`
 * and `service.pid`, are deliberately left behind: they belong to that daemon,
 * which removes them itself when it stops.
 */
async function migrateLegacyRoot(): Promise<void> {
  const entries = await readdir(legacyRoot).catch(() => [] as string[])
  if (entries.length === 0) return
  await mkdir(root, { recursive: true, mode: 0o700 })
  for (const entry of entries) {
    if (entry === 'service.sock' || entry === 'service.pid') continue
    const target = join(root, entry)
    if (
      await access(target).then(
        () => true,
        () => false
      )
    )
      continue
    await rename(join(legacyRoot, entry), target).catch(() => undefined)
  }
  const remaining = await readdir(legacyRoot).catch(() => [] as string[])
  if (remaining.length === 0)
    await rm(legacyRoot, { recursive: true, force: true }).catch(() => undefined)
}

/** Supervision commands are local process control, never a long-running job. */
const SUPERVISION_COMMAND_TIMEOUT_MS = 20_000

/** Run one supervision command, resolving to whether it succeeded. */
const runSupervisionCommand: SupervisionCommandRunner = (program, args, environment) =>
  new Promise((resolve) => {
    let settled = false
    let child: ChildProcess
    try {
      child = spawn(program, [...args], {
        stdio: 'ignore',
        windowsHide: true,
        env: environment ?? process.env
      })
    } catch {
      resolve(false)
      return
    }
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(false)
    }, SUPERVISION_COMMAND_TIMEOUT_MS)
    timer.unref()
    child.once('error', () => finish(false))
    child.once('close', (code) => finish(code === 0))
  })
/**
 * Whether this Linux Oven runs a systemd user manager this account can drive.
 *
 * Both halves matter: `systemctl --user` needs a runtime directory to talk to,
 * and without `/run/systemd/system` there is no systemd at all (a container, a
 * WSL distribution without systemd, a Termux device before systemd even applies).
 */
async function hasSystemdUserManager(): Promise<boolean> {
  if (!process.env['XDG_RUNTIME_DIR']) return false
  return await access('/run/systemd/system').then(
    () => true,
    () => false
  )
}

/**
 * Launch the daemon under the machine's own supervisor, so a restart brings it
 * back, and fall back to a detached process only where no supervisor exists.
 *
 * POSIX has two supervisors worth using, and both install a script that outlives
 * this SSH session: runit on Termux (with `~/.termux/boot` restoring it after the
 * device restarts) and a systemd user unit on Linux. Detaching alone was the
 * reason an Oven disappeared after a reboot, so it is now the last resort.
 *
 * Windows cannot: a console program a Windows shell
 * starts owns a visible window, and OpenSSH there ends the whole process tree
 * when the session closes, so a detached child both flashes a window and dies
 * with the connection. A scheduled task started through the hidden launcher
 * fixes both: the Task Scheduler owns the process rather than the SSH session,
 * `wscript` starts node with window style 0, and the same task returns the
 * service after a reboot. The WMI fallback keeps a machine that forbids
 * scheduled tasks working, still hidden.
 */
async function startDaemon(): Promise<void> {
  if (process.platform !== 'win32') {
    const revision = process.env['CODEINOVEN_OVEN_REVISION']
    const supervision: OvenSupervisionInput = {
      nodePath: process.execPath,
      servicePath: process.argv[1],
      dataRoot: root,
      ...(revision ? { revision } : {}),
      home: homedir(),
      ...(process.env['PREFIX'] ? { prefix: process.env['PREFIX'] } : {})
    }
    const target = supervisionTarget({
      platform: process.platform,
      prefix: process.env['PREFIX'],
      systemdUserManager: await hasSystemdUserManager()
    })
    if (target.termux) {
      await installTermuxSupervision(supervision)
      if (await startTermuxSupervision(supervision, runSupervisionCommand)) return
    } else if (target.systemd) {
      if (await startSystemdSupervision(supervision, runSupervisionCommand)) return
    }
    // No supervisor took the service: detach it, so this release still works on
    // a machine that has neither runit nor systemd, and the caller's health wait
    // can still see it answer.
    const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    })
    child.unref()
    return
  }
  const revision = process.env['CODEINOVEN_OVEN_REVISION']
  const launcher = join(root, WINDOWS_LAUNCHER_FILE)
  await writeFile(
    launcher,
    windowsLauncherScript({
      nodePath: process.execPath,
      servicePath: process.argv[1],
      dataRoot: root,
      ...(revision ? { revision } : {})
    }),
    { mode: 0o600 }
  )
  // The previous release launched through cmd.exe, which flashed a window.
  await rm(join(root, legacyWindowsLauncherFile()), { force: true }).catch(() => undefined)
  if (await registerWindowsTask(launcher)) {
    await enableWindowsTask()
    if (await runWindowsTask()) return
  }
  // Encoded so no layer of shell quoting can mangle a path with a space in it.
  const program = [
    '$ErrorActionPreference = "Stop"',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '${windowsTaskAction(launcher).replace(/'/gu, "''")}' }`,
    'if ($r.ReturnValue -ne 0) { exit 1 }'
  ].join('; ')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(program, 'utf16le').toString('base64')
      ],
      { stdio: 'ignore', windowsHide: true }
    )
    child.once('error', reject)
    child.once('close', (code) =>
      code === 0 ? resolve() : reject(new Error('The Oven service could not be launched.'))
    )
  })
}

async function daemon(): Promise<void> {
  await migrateLegacyRoot()
  await mkdir(join(root, 'runs'), { recursive: true, mode: 0o700 })
  // An exclusive pid file prevents simultaneous ensure calls from replacing a live socket.
  let lock
  try {
    lock = await open(lockPath, 'wx', 0o600)
  } catch {
    const pid = Number(await readFile(lockPath, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new Error(
        'Invalid Oven service lock. Remove service.pid after checking that no service is running.'
      )
    try {
      process.kill(pid, 0)
      return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    await unlink(lockPath)
    return daemon()
  }
  try {
    await lock.writeFile(String(process.pid))
  } finally {
    await lock.close()
  }
  await unlink(socketPath).catch(() => undefined)
  const entries = (await readdir(join(root, 'runs')))
    .filter((name) => name.endsWith('.json'))
    .slice(0, MAX_RUNS)
  for (const name of entries) {
    const run = JSON.parse(await readFile(join(root, 'runs', name), 'utf8')) as OvenRun
    id(run.id)
    if (run.status === 'running') {
      run.status = 'failed'
      run.finishedAt = Date.now()
      await atomicState(run)
    }
    // Settled runs never append again. Their journals are read only on request,
    // so restarting does not scan hundreds of megabytes of old output.
    const sequence = 0
    const bytes = 0
    jobs.set(run.id, {
      run,
      sequence,
      bytes,
      queuedBytes: 0,
      tail: Promise.resolve(),
      offsets: new Map([[0, 0]])
    })
  }
  const server = createServer((socket) =>
    receive(socket, async (line) => {
      try {
        const operation = requestTail.catch(() => undefined).then(() => dispatch(JSON.parse(line)))
        requestTail = operation
        return JSON.stringify({ ok: true, value: await operation })
      } catch (error) {
        return JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'Oven request failed.'
        })
      }
    })
  )
  server.maxConnections = 8
  shutDownServer = () => {
    server.close(() => {
      void unlink(socketPath)
        .catch(() => undefined)
        .then(() => unlink(lockPath))
        .catch(() => undefined)
    })
  }
  server.listen(socketPath)
  await once(server, 'listening')
  // A named pipe on Windows carries no file mode to restrict.
  if (process.platform !== 'win32') await chmod(socketPath, 0o600)
}

function request(data: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath)
    let response = ''
    let bytes = 0
    socket.setEncoding('utf8')
    socket.setTimeout(30_000, () => socket.destroy(new Error('Oven request timed out.')))
    socket.on('connect', () => socket.write(data))
    socket.on('data', (text: string) => {
      bytes += Buffer.byteLength(text)
      if (bytes > 2 * MAX_REQUEST) socket.destroy(new Error('Oven response exceeds the limit.'))
      else response += text
    })
    socket.on('error', reject)
    socket.on('end', () => resolve(response))
  })
}

/**
 * Answer one line that arrived on the long-lived channel.
 *
 * File and local-Git work is answered here, in this process, instead of being
 * forwarded to the daemon socket. The socket is sized for control messages: it
 * rejects a body over 1 MiB and a response over 2 MiB, and it times out at 30 s,
 * while a `root-operation` carries a file's contents. Answering in process also
 * means the action costs one round trip and never starts a second Node, which is
 * what made opening a folder take seconds on a Windows Oven.
 *
 * A forwarded line is sent to the daemon with its newline restored, because the
 * daemon dispatches on that newline and nothing else. Dropping it here is what
 * made this whole mode useless in its first release: every forwarded request sat
 * in the daemon's buffer until the 30 s socket timeout, so each one failed and
 * the app fell back to a fresh SSH and Node process for every single action.
 */
async function attachLine(payload: string): Promise<string> {
  let parsed: Record<string, unknown> | undefined
  try {
    parsed = record(JSON.parse(payload))
  } catch {
    // Not an object envelope: let the daemon answer it exactly as before.
    return await request(`${payload}\n`)
  }
  if (parsed['method'] !== 'root-operation') return await request(`${payload}\n`)
  if (parsed['protocolVersion'] !== PROTOCOL)
    return JSON.stringify({ ok: false, error: 'Oven protocol version mismatch.' })
  try {
    return JSON.stringify({ ok: true, value: await ovenRootOperation(parsed['input']) })
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'The remote operation failed.'
    })
  }
}

/**
 * Answer requests over one long-lived channel instead of one process each.
 *
 * Every other request mode is a process per request, which on a Windows Oven
 * costs seconds before the request is even read, on every screen. This mode keeps
 * the process alive and answers newline-delimited JSON lines from stdin, so a
 * request is one round trip to the daemon and the app keeps it open while an Oven
 * is in use.
 */
async function attach(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    const payload = line.trim()
    if (!payload) continue
    let response: string
    try {
      response = await attachLine(payload)
    } catch (error) {
      response = JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : 'Oven request failed.'
      })
    }
    // One line per response: JSON escapes its own newlines, so the client can
    // split on them and match answers to requests in order.
    process.stdout.write(`${response.trim()}\n`)
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === 'daemon') return daemon()
  if (process.argv[2] === 'attach') return attach()
  if (process.argv[2] === 'ensure') {
    const data = `${JSON.stringify({ method: 'probe', protocolVersion: PROTOCOL })}\n`
    const current = await answerOrNull(data)
    if (current && isCurrentServiceAnswer(current, revision)) {
      process.stdout.write(current)
      return
    }
    // A service that is still working for someone is never pulled out from
    // under it. Everything else is replaced, however it was left behind.
    if (activeRunsIn(current) > 0)
      throw new Error('Finish active runs before updating the Oven service.')
    // Ask the service that is in the way to leave. An older bundle may not know
    // the request at all, which is exactly why the process itself is also
    // removed below instead of being trusted to exit.
    await answerOrNull(`${JSON.stringify({ method: 'shutdown', protocolVersion: PROTOCOL })}\n`)
    await waitForNoAnswer()
    // Two attempts, each a complete replacement: start the installed bundle,
    // and if it cannot bind because the previous install is still standing,
    // remove that process with its lock and socket, then start again. One
    // attempt alone is what left an Oven on an old bundle after an update that
    // had already been written to disk.
    for (let attempt = 0; attempt < 2; attempt++) {
      // Same normalized remote environment as the Node client; no desktop marker.
      await startDaemon()
      const healthy = await waitForCurrentService(data)
      if (healthy) {
        process.stdout.write(healthy)
        return
      }
      await forceStopDaemon()
    }
    throw new Error(
      'The Oven service was installed but the previous service could not be replaced. Stop it with `cio-oven stop`, then install the service again.'
    )
  }
  if (!['request', 'workspace', 'root-operation'].includes(process.argv[2]))
    throw new Error('Use ensure, attach, request, workspace, or daemon.')
  let data = ''
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > (process.argv[2] === 'root-operation' ? 8 * MAX_REQUEST : MAX_REQUEST))
      throw new Error('The Oven request exceeds its size limit.')
    data += String(chunk)
  }
  if (process.argv[2] === 'workspace' || process.argv[2] === 'root-operation') {
    try {
      process.stdout.write(
        JSON.stringify({
          ok: true,
          value: await (process.argv[2] === 'workspace'
            ? ovenWorkspace(JSON.parse(data))
            : ovenRootOperation(JSON.parse(data)))
        }) + '\n'
      )
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : 'The remote workspace operation failed.'
        }) + '\n'
      )
    }
    return
  }
  process.stdout.write(await request(data))
}

void main().catch((error: unknown) => {
  // Name the real reason. This used to print a fixed "install the service again",
  // which sent users to reinstall a healthy service instead of showing them what
  // actually failed (an unknown mode, a permission problem, a bad data root).
  const reason = error instanceof Error ? error.message : String(error)
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: `The Oven service could not handle this request: ${reason}`
    })}\n`
  )
  process.exitCode = 1
})
