/** Standalone Node service. No Electron, desktop paths, or app-owned process markers. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
import { availableParallelism, hostname, homedir, totalmem, tmpdir } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { once } from 'node:events'
import type { OvenProbe, OvenRun, OvenRunEvent } from '../../../lib/ovens'
import { ovenHarnessIdForCommand } from '../../../lib/ovens'
import { listHarnesses } from '../../agents/harness-registry'
import { OPENCODE_COMMAND_ALIASES } from '../../../lib/opencode-version'
import { OVEN_DATA_DIRECTORY, OVEN_LEGACY_DATA_DIRECTORY } from './oven-root-paths'
import { OVEN_NPM_PREFIX } from '../oven-harness-paths'
import { ovenRootOperation } from './oven-root-operations'
import { ovenWorkspace } from './oven-workspace'

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
const versionCache = new Map<
  string,
  {
    path: string | null
    version: string | null
    health: string
    issueCategory?: string
    checkedAt: number
  }
>()
const root = process.env['CODEINOVEN_OVEN_DATA_ROOT'] ?? join(homedir(), OVEN_DATA_DIRECTORY)
/** Where earlier releases kept the same state, before it moved into the app namespace. */
const legacyRoot = join(homedir(), OVEN_LEGACY_DATA_DIRECTORY)
if (process.platform !== 'win32') {
  const npmPrefix = join(homedir(), OVEN_NPM_PREFIX)
  process.env['PATH'] = `${join(npmPrefix, 'bin')}:${process.env['PATH'] ?? ''}`
  process.env['npm_config_prefix'] = npmPrefix
}
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
const jobs = new Map<string, Job>()
let shutDownServer: (() => void) | undefined
let requestTail: Promise<unknown> = Promise.resolve()
const MAX_REQUEST = 1024 * 1024
const MAX_RUNS = 64
const MAX_ACTIVE = 4
const MAX_JOURNAL = 64 * 1024 * 1024

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

/** Run one harness version command, bounded so a hung binary cannot stall a probe. */
function harnessVersion(path: string, versionArgs: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    const child = spawn(path, [...versionArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
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
      const line = output
        .split(/\r?\n/u)
        .map((entry) => entry.trim())
        .find(Boolean)
      resolve(line ? line.slice(0, 200) : null)
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
            updateAvailable: false,
            checkedAt: cached.checkedAt,
            cached: true
          })
          continue
        }
        const path = await executable(harness.command)
        const version = path ? await harnessVersion(path, harness.versionArgs) : null
        const health = !path ? 'missing' : version ? 'healthy' : 'broken'
        const issueCategory = !path ? 'not-installed' : version ? undefined : 'broken-executable'
        const entry = { path, version, health, issueCategory, checkedAt: Date.now() }
        versionCache.set(harness.id, entry)
        inventory.push({
          harnessId: harness.id,
          command: harness.command,
          executablePath: path,
          installedVersion: version,
          health,
          ...(issueCategory ? { issueCategory } : {}),
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
    platform: process.platform,
    architecture: process.arch,
    home,
    nodeVersion: process.versions.node,
    // The service reports the zone its own process runs on, which is the Oven's
    // system zone and always an IANA id, even where the platform names its own.
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    specs: {
      hostname: hostname(),
      platform: process.platform,
      architecture: process.arch,
      cpuCount: availableParallelism(),
      memoryBytes: totalmem(),
      diskBytes: disk.blocks * disk.bsize,
      diskAvailableBytes: disk.bavail * disk.bsize,
      nodeVersion: process.versions.node
    },
    harnesses,
    activeRuns: [...jobs.values()].filter((job) => job.run.status === 'running').length,
    inventory
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
  const path = await executable(value.command)
  if (!path) throw new Error('This harness is not installed on the Oven.')
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
    const child = spawn(path, value.args as string[], {
      cwd: run.cwd,
      env,
      detached: process.platform !== 'win32',
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

/**
 * Launch the daemon so it outlives whatever started it.
 *
 * POSIX can simply detach. Windows cannot: OpenSSH there ends the whole process
 * tree when the session closes, so a detached child dies with it and the Oven
 * goes offline the moment the user's shell exits. A process created by the WMI
 * provider is owned by that provider rather than the session, which is what
 * makes the service durable. It is launched through a command script so the
 * daemon still receives the environment this call meant to give it.
 */
async function startDaemon(): Promise<void> {
  if (process.platform !== 'win32') {
    const child = spawn(process.execPath, [process.argv[1], 'daemon'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    })
    child.unref()
    return
  }
  const revision = process.env['CODEINOVEN_OVEN_REVISION']
  const launcher = join(root, 'service-start.cmd')
  await writeFile(
    launcher,
    [
      '@echo off',
      `set "CODEINOVEN_OVEN_DATA_ROOT=${root}"`,
      ...(revision ? [`set "CODEINOVEN_OVEN_REVISION=${revision}"`] : []),
      `set "PATH=${dirname(process.execPath)};%PATH%"`,
      `"${process.execPath}" "${process.argv[1]}" daemon`,
      ''
    ].join('\r\n'),
    { mode: 0o600 }
  )
  // Encoded so no layer of shell quoting can mangle a path with a space in it.
  const program = [
    '$ErrorActionPreference = "Stop"',
    `$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'cmd.exe /c ""${launcher}""' }`,
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

async function main(): Promise<void> {
  if (process.argv[2] === 'daemon') return daemon()
  if (process.argv[2] === 'ensure') {
    const data = `${JSON.stringify({ method: 'probe', protocolVersion: PROTOCOL })}\n`
    try {
      const output = await request(data)
      const response = JSON.parse(output) as { ok: boolean; value?: OvenProbe }
      if (response.ok && response.value?.serviceRevision === revision) {
        process.stdout.write(output)
        return
      }
      if (response.value?.activeRuns)
        throw new Error('Finish active runs before updating the Oven service.')
      const stopped = JSON.parse(
        await request(`${JSON.stringify({ method: 'shutdown', protocolVersion: PROTOCOL })}\n`)
      ) as { ok: boolean; error?: string }
      if (!stopped.ok) throw new Error(stopped.error || 'The existing Oven service could not stop.')
      await new Promise<void>((resolve) => setTimeout(resolve, 250))
    } catch (error) {
      if (!['ECONNREFUSED', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? ''))
        throw error
      /* Start an absent service. */
    }
    // Same normalized remote environment as the Node client; no desktop ownership marker.
    await startDaemon()
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
      try {
        process.stdout.write(await request(data))
        return
      } catch {
        /* Wait for socket startup. */
      }
    }
    throw new Error('The Oven service could not start.')
  }
  if (!['request', 'workspace', 'root-operation'].includes(process.argv[2]))
    throw new Error('Use ensure, request, workspace, or daemon.')
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

void main().catch(() => {
  process.stdout.write(
    '{"ok":false,"error":"The Oven service is unavailable. Check its Node runtime and install the service again."}\n'
  )
  process.exitCode = 1
})
