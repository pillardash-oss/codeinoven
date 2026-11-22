import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { AgentRunningProcess, TaskManagerProcess } from '../../lib/types'
import type { AgentProcessObserver } from '../drivers/driver.interface'
import {
  INSTANCE_OWNER_ID,
  OWNED_PROCESS_MARKER,
  OWNED_SESSION_MARKER,
  isOwnerId,
  isOwnerRunning,
  isRecycledPid,
  isSharedDaemon,
  startedAtFromElapsed
} from '../system/process-ownership'
import { Logger } from '../system/logger'
import { OwnedProcessJournal } from '../system/owned-process-journal'
import { broadcastAgentProcessesChanged } from '../chat/thread-events'

const execFileAsync = promisify(execFile)
const PROCESS_EXIT_GRACE_MS = 1_500
const PORT_SCAN_TIMEOUT_MS = 2_000
/**
 * Minimum gap between two process snapshots.
 *
 * One snapshot is two process spawns (`ps` for the table, `ps -E` for the
 * ownership probe) plus parsing, and several surfaces ask for the same answer in
 * the same instant: the open thread's badge, the sources panel, and the task
 * manager. A scan starting within this window of the previous one reuses its
 * result. Callers that must observe a change they just made force it.
 */
const SCAN_MIN_INTERVAL_MS = 1_500
/** Maximum pids per batched `ps -E` ownership probe. */
const OWNERSHIP_PROBE_CHUNK = 64
/** Maximum pids per batched `lsof` working-directory probe. */
const CWD_PROBE_CHUNK = 64
/** A probe is best-effort: a wedged `lsof` must never stall a scan. */
const CWD_PROBE_TIMEOUT_MS = 2_000
/** Key under which app-wide roots (e.g. the shared opencode server) are tracked. */
const APP_SCOPE = '__codeinoven_app_scope__'

/**
 * OpenCode's own managed background service (`opencode serve --service`).
 *
 * OpenCode starts this daemon for its own client commands and re-parents it to
 * launchd, so it outlives whatever asked for it. The app never talks to it   it
 * spawns private `serve --port 0` servers for its own work   so a stray one is
 * never adopted as an app runtime and is reaped on the next launch.
 */
const OPENCODE_SERVICE_DAEMON_PATTERN =
  /(?:^|[\\/])opencode(?:\.exe)?["']?\s+serve\s+--service(?:\s|$)/u

function isOpenCodeServiceDaemon(command: string): boolean {
  return OPENCODE_SERVICE_DAEMON_PATTERN.test(command)
}

export interface ProcessSnapshotEntry {
  pid: number
  parentPid: number
  command: string
  cpuPercent: number | null
  memoryBytes: number | null
  /** When it started, where the platform says. What tells a recycled pid apart. */
  startedAt?: number | undefined
}

interface ProcessOwner {
  projectId: string
  threadId: string
}

interface HarnessRoot {
  pid: number
  command: string
  cwd: string
  startedAt: number
}

interface TrackedProcess extends AgentRunningProcess {
  sessionId: string
  cwd: string | null
}

interface ProcessOwnership {
  /** App ownership marker present; `null` when the platform cannot tell. */
  owned: boolean | null
  /** The instance whose stamp it carries; `null` for none or an older version's. */
  instance: string | null
  /** CodeInOven session id stamped in the process environment, when known. */
  sessionId: string | null
}
/** Read a process's markers. `1` is what versions before per-instance stamps wrote. */
function ownershipFrom(marker: string | null, sessionId: string | null): ProcessOwnership {
  const instance = isOwnerId(marker) ? marker : null
  return { owned: instance !== null || marker === '1', instance, sessionId }
}

export interface ReapOrphansResult {
  killed: number[]
  skipped: number[]
}

export interface ReapOrphansOptions {
  /**
   * Kill a journaled root only when its app-ownership marker is positively
   * verified, instead of accepting an orphaned parent as proof of ownership.
   * The repeating sweep needs this: a pid the OS recycled between sweeps must
   * never be signalled on a guess. The one-shot startup reap keeps the orphan
   * fallback, because its journal was written moments before it runs.
   */
  requireOwnershipProof?: boolean
}

type ProcessSnapshotter = () => Promise<ProcessSnapshotEntry[]>

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isMissingProcessError(error: unknown): boolean {
  return record(error)?.['code'] === 'ESRCH'
}

function windowsEntries(value: unknown): ProcessSnapshotEntry[] {
  const rows = Array.isArray(value) ? value : [value]
  return rows.flatMap((row) => {
    const item = record(row)
    const pid = item?.['ProcessId']
    const parentPid = item?.['ParentProcessId']
    if (typeof pid !== 'number' || typeof parentPid !== 'number') return []
    const commandLine = item?.['CommandLine']
    const name = item?.['Name']
    const command =
      typeof commandLine === 'string' && commandLine.trim()
        ? commandLine.trim()
        : typeof name === 'string'
          ? name
          : `Process ${pid}`
    const cpuPercent = item?.['CpuPercent']
    const memoryBytes = item?.['MemoryBytes']
    return [
      {
        pid,
        parentPid,
        command,
        cpuPercent: typeof cpuPercent === 'number' ? cpuPercent : null,
        memoryBytes: typeof memoryBytes === 'number' ? memoryBytes : null
      }
    ]
  })
}

async function snapshotWindowsProcesses(): Promise<ProcessSnapshotEntry[]> {
  const script = [
    '$perf = @{}',
    'Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | ForEach-Object { $perf[[int]$_.IDProcess] = $_ }',
    'Get-CimInstance Win32_Process | ForEach-Object {',
    '  $sample = $perf[[int]$_.ProcessId]',
    '  $cpu = if ($sample) { [double]$sample.PercentProcessorTime } else { $null }',
    '  [PSCustomObject]@{ ProcessId = [int]$_.ProcessId; ParentProcessId = [int]$_.ParentProcessId; Name = $_.Name; CommandLine = $_.CommandLine; CpuPercent = $cpu; MemoryBytes = [double]$_.WorkingSetSize }',
    '} | ConvertTo-Json -Compress'
  ].join('; ')
  const { stdout } = await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script
  ])
  const text = stdout.trim()
  return text ? windowsEntries(JSON.parse(text) as unknown) : []
}

async function snapshotUnixProcesses(): Promise<ProcessSnapshotEntry[]> {
  const capturedAt = Date.now()
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,etime=,command='], {
    // The whole table with full command lines outgrows the 1 MiB default on a busy machine.
    maxBuffer: 8 * 1024 * 1024
  })
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.,]+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/u)
    if (!match) return []
    return [
      {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        cpuPercent: Number(match[3]?.replace(',', '.')),
        memoryBytes: Number(match[4]) * 1024,
        startedAt: startedAtFromElapsed(match[5] ?? '', capturedAt),
        command: match[6]?.trim() || `Process ${match[1]}`
      }
    ]
  })
}

async function defaultSnapshotter(): Promise<ProcessSnapshotEntry[]> {
  return process.platform === 'win32' ? snapshotWindowsProcesses() : snapshotUnixProcesses()
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function childrenIndex(
  snapshot: readonly ProcessSnapshotEntry[]
): Map<number, ProcessSnapshotEntry[]> {
  const index = new Map<number, ProcessSnapshotEntry[]>()
  for (const entry of snapshot) {
    const children = index.get(entry.parentPid) ?? []
    children.push(entry)
    index.set(entry.parentPid, children)
  }
  return index
}

/** Whether a process is a shared daemon or sits below one, looking no higher than `stopAt`. */
function isUnderSharedDaemon(
  pid: number,
  byPid: ReadonlyMap<number, ProcessSnapshotEntry>,
  stopAt = 0
): boolean {
  const seen = new Set<number>()
  let entry = byPid.get(pid)
  while (entry && entry.pid !== stopAt && !seen.has(entry.pid)) {
    if (isSharedDaemon(entry.command)) return true
    seen.add(entry.pid)
    entry = byPid.get(entry.parentPid)
  }
  return false
}

function descendantsOf(
  rootPid: number,
  childrenByParent: ReadonlyMap<number, ProcessSnapshotEntry[]>
): ProcessSnapshotEntry[] {
  const descendants: ProcessSnapshotEntry[] = []
  const pending = [...(childrenByParent.get(rootPid) ?? [])]
  const visited = new Set<number>()
  while (pending.length > 0) {
    const child = pending.shift()
    if (!child || visited.has(child.pid)) continue
    visited.add(child.pid)
    descendants.push(child)
    pending.push(...(childrenByParent.get(child.pid) ?? []))
  }
  return descendants
}

/** Tracks and terminates subprocesses created by task-owned harness processes. */
export class AgentProcessService implements AgentProcessObserver {
  private readonly owners = new Map<string, ProcessOwner>()
  private readonly roots = new Map<string, Map<number, HarnessRoot>>()
  private readonly tracked = new Map<string, Map<number, TrackedProcess>>()
  private scanInFlight: Promise<void> | null = null
  private lastScanAt = 0
  private journal: OwnedProcessJournal | null = null
  private lastSnapshot: ProcessSnapshotEntry[] = []

  constructor(private readonly snapshotter: ProcessSnapshotter = defaultSnapshotter) {}

  /**
   * Persist which harness roots this app spawned so a future launch can reap
   * orphans without ever touching a harness the user runs outside the app.
   */
  attachJournal(filePath: string | undefined): void {
    if (!filePath) return
    this.journal = new OwnedProcessJournal(filePath)
  }

  claimSession(sessionId: string, projectId: string, threadId: string): void {
    this.owners.set(sessionId, { projectId, threadId })
  }

  watchProcess(
    sessionId: string | undefined,
    pid: number | undefined,
    command: string,
    cwd: string
  ): void {
    if (!pid || pid <= 0) return
    const scope = sessionId ?? APP_SCOPE
    let sessionRoots = this.roots.get(scope)
    if (!sessionRoots) {
      sessionRoots = new Map()
      this.roots.set(scope, sessionRoots)
    }
    sessionRoots.set(pid, { pid, command, cwd, startedAt: Date.now() })
    this.journal?.register(pid, command, cwd)
  }

  async list(projectId: string, threadId: string, refresh = true): Promise<AgentRunningProcess[]> {
    if (refresh) await this.scan()
    const unique = new Map<number, AgentRunningProcess>()
    for (const [sessionId, owner] of this.owners) {
      if (owner.projectId !== projectId || owner.threadId !== threadId) continue
      for (const process of this.tracked.get(sessionId)?.values() ?? []) {
        if (!unique.has(process.pid)) {
          unique.set(process.pid, {
            pid: process.pid,
            parentPid: process.parentPid,
            command: process.command,
            startedAt: process.startedAt,
            scope: 'thread'
          })
        }
      }
    }
    return [...unique.values()].sort((left, right) => left.startedAt - right.startedAt)
  }

  async killProcess(
    projectId: string,
    threadId: string,
    pid: number,
    force = false
  ): Promise<void> {
    const processes = await this.list(projectId, threadId)
    if (!processes.some((entry) => entry.pid === pid)) {
      throw new Error(`Process ${pid} is not owned by this thread`)
    }
    await this.killTree(pid, force)
    await this.scan({ force: true })
  }

  /**
   * Global kill used by the task manager: targets any app-owned pid regardless
   * of project/thread. `force` skips the graceful SIGTERM stage and escalates
   * straight to SIGKILL (or `taskkill /F` on Windows).
   */
  async killProcessGlobal(pid: number, force: boolean): Promise<void> {
    if (!this.ownsProcess(pid)) throw new Error(`Process ${pid} is not owned by this app`)
    await this.killTree(pid, force)
    await this.scan({ force: true })
  }

  /**
   * App-wide process list for the task manager. Enumerates every owned harness
   * root and descendant across all sessions (thread-scoped and app-scoped),
   * attaching the project/thread that owns each, its working directory, and the
   * TCP ports it is listening on (best-effort OS detection).
   */
  async listAll(): Promise<TaskManagerProcess[]> {
    await this.scan()
    const snapshotByPid = this.snapshotTable()
    // One row reports the resources of that one process. A harness root is not
    // given its descendants' totals: every descendant it spawns is listed as its
    // own row, so folding a tree into the root would show the same bytes twice
    // and read as the root process using them (a 2.3 GB `svelte-check` child
    // made its `pi` parent look like it used 2.5 GB). Totals live on the owner
    // and app nodes, which sum the rows actually listed.
    const resourcesFor = (pid: number) => this.ownResources(pid, snapshotByPid)
    const pids = new Set<number>()
    for (const processes of this.tracked.values()) {
      for (const process of processes.values()) pids.add(process.pid)
    }
    for (const sessionRoots of this.roots.values()) {
      for (const root of sessionRoots.values()) pids.add(root.pid)
    }
    const portsByPid = await this.detectPorts([...pids])

    const unique = new Map<number, TaskManagerProcess>()
    for (const [sessionId, owner] of this.owners) {
      const sessionRoots = this.roots.get(sessionId)
      for (const root of sessionRoots?.values() ?? []) {
        unique.set(root.pid, {
          pid: root.pid,
          parentPid: 0,
          command: root.command,
          startedAt: root.startedAt,
          scope: 'thread',
          cwd: root.cwd,
          projectId: owner.projectId,
          threadId: owner.threadId,
          ports: portsByPid.get(root.pid) ?? [],
          ...resourcesFor(root.pid)
        })
      }
      for (const process of this.tracked.get(sessionId)?.values() ?? []) {
        unique.set(process.pid, {
          pid: process.pid,
          parentPid: process.parentPid,
          command: process.command,
          startedAt: process.startedAt,
          scope: process.scope,
          cwd: process.cwd,
          projectId: owner.projectId,
          threadId: owner.threadId,
          ports: portsByPid.get(process.pid) ?? [],
          ...resourcesFor(process.pid)
        })
      }
    }
    // App-scoped processes (descendants of a shared/pooled harness) carry no
    // project/thread owner, so those fields are null in the task manager list.
    for (const root of this.roots.get(APP_SCOPE)?.values() ?? []) {
      unique.set(root.pid, {
        pid: root.pid,
        parentPid: 0,
        command: root.command,
        startedAt: root.startedAt,
        scope: 'app',
        cwd: root.cwd,
        projectId: null,
        threadId: null,
        ports: portsByPid.get(root.pid) ?? [],
        ...resourcesFor(root.pid)
      })
    }
    for (const process of this.tracked.get(APP_SCOPE)?.values() ?? []) {
      unique.set(process.pid, {
        pid: process.pid,
        parentPid: process.parentPid,
        command: process.command,
        startedAt: process.startedAt,
        scope: 'app',
        cwd: process.cwd,
        projectId: null,
        threadId: null,
        ports: portsByPid.get(process.pid) ?? [],
        ...resourcesFor(process.pid)
      })
    }
    return [...unique.values()].sort((left, right) => left.startedAt - right.startedAt)
  }

  /**
   * Own-process CPU and memory for arbitrary pids, read after a snapshot scan.
   *
   * A registered service is the app's own child (a thread's stdio MCP server,
   * the model gateway), so no harness root reaches it and it is never a row in
   * `listAll()`. The task manager still needs those numbers to make an owner
   * node's total the total of everything under it. A pid the snapshot does not
   * know reports null rather than zero, so a stale pid never reads as idle.
   */
  async processResources(
    pids: readonly number[]
  ): Promise<Map<number, { cpuPercent: number | null; memoryBytes: number | null }>> {
    const resources = new Map<number, { cpuPercent: number | null; memoryBytes: number | null }>()
    if (pids.length === 0) return resources
    await this.scan()
    const snapshotByPid = this.snapshotTable()
    for (const pid of pids) resources.set(pid, this.ownResources(pid, snapshotByPid))
    return resources
  }

  /** Snapshot of the last scan, indexed by pid. */
  private snapshotTable(): Map<number, ProcessSnapshotEntry> {
    return new Map(this.lastSnapshot.map((entry) => [entry.pid, entry]))
  }

  /** Own-process resources for one pid, out of a snapshot table. */
  private ownResources(
    pid: number,
    snapshotByPid: ReadonlyMap<number, ProcessSnapshotEntry>
  ): { cpuPercent: number | null; memoryBytes: number | null } {
    const entry = snapshotByPid.get(pid)
    return {
      cpuPercent: finiteOrNull(entry?.cpuPercent),
      memoryBytes: finiteOrNull(entry?.memoryBytes)
    }
  }

  /**
   * Best-effort detection of the TCP ports each owned pid is currently
   * listening on. One batched `lsof` (unix) / `netstat` (windows) snapshot per
   * call; failures degrade to an empty map so the task manager never blocks on
   * a missing tool.
   */
  private async detectPorts(pids: readonly number[]): Promise<Map<number, number[]>> {
    const wanted = new Set(pids)
    if (wanted.size === 0) return new Map()
    const map = new Map<number, number[]>()
    try {
      const entries =
        process.platform === 'win32'
          ? await this.snapshotWindowsListeningPorts()
          : await this.snapshotUnixListeningPorts()
      for (const [pid, port] of entries) {
        if (!wanted.has(pid)) continue
        const existing = map.get(pid)
        if (existing) existing.push(port)
        else map.set(pid, [port])
      }
    } catch {
      // Port detection is strictly best-effort.
    }
    return map
  }

  private async snapshotUnixListeningPorts(): Promise<Array<[number, number]>> {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pfn'], {
      timeout: PORT_SCAN_TIMEOUT_MS,
      windowsHide: true
    })
    const result: Array<[number, number]> = []
    let currentPid = 0
    for (const line of stdout.split(/\r?\n/u)) {
      if (!line) continue
      if (line.startsWith('p')) {
        currentPid = Number(line.slice(1))
      } else if (line.startsWith('n') && currentPid > 0) {
        const name = line.slice(1)
        const listenIndex = name.lastIndexOf('(LISTEN)')
        const listenPart = listenIndex >= 0 ? name.slice(0, listenIndex).trimEnd() : name
        const match = listenPart.match(/(\d+)\s*$/u)
        if (match) result.push([currentPid, Number(match[1])])
      }
    }
    return result
  }

  private async snapshotWindowsListeningPorts(): Promise<Array<[number, number]>> {
    const { stdout } = await execFileAsync('netstat.exe', ['-ano', '-p', 'TCP'], {
      timeout: PORT_SCAN_TIMEOUT_MS,
      windowsHide: true
    })
    const result: Array<[number, number]> = []
    for (const line of stdout.split(/\r?\n/u)) {
      const fields = line.trim().split(/\s+/u)
      if (fields.length < 5 || fields[3] !== 'LISTENING') continue
      const local = fields[1]
      const portMatch = local.match(/:([^:]+)$/u)
      const pid = Number(fields.at(-1))
      if (portMatch && pid > 0) result.push([pid, Number(portMatch[1])])
    }
    return result
  }

  async killThread(projectId: string, threadId: string): Promise<void> {
    const sessionIds = this.sessionsForThread(projectId, threadId)
    await this.stopRecorded(sessionIds)
    for (const sessionId of sessionIds) {
      this.tracked.delete(sessionId)
      for (const root of this.roots.get(sessionId)?.values() ?? []) {
        this.journal?.unregister(root.pid)
      }
      this.roots.delete(sessionId)
    }
    broadcastAgentProcessesChanged(projectId, threadId)
  }

  async releaseThread(projectId: string, threadId: string): Promise<void> {
    const sessionIds = this.sessionsForThread(projectId, threadId)
    await this.killThread(projectId, threadId)
    for (const sessionId of sessionIds) {
      this.roots.delete(sessionId)
      this.owners.delete(sessionId)
    }
  }

  async killAll(): Promise<void> {
    const owners = new Map(this.owners)
    const stopped = await this.stopRecorded([
      ...new Set([...this.roots.keys(), ...this.tracked.keys()])
    ])
    this.tracked.clear()
    this.roots.clear()
    this.owners.clear()
    // What could not be verified stays journaled, for the next launch to reap.
    if (this.journal && stopped) {
      this.journal.clear()
      await this.journal.flush()
    }
    for (const owner of owners.values()) {
      broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
    }
  }

  /**
   * The automatic stop behind a quit and a thread cleanup: end what these sessions
   * recorded, as long as each pid still names that same process and is not a daemon
   * the machine shares.
   *
   * @returns false when the process table was unreadable, so nothing was signalled:
   * a pid that cannot be identified is not known to be this instance's.
   */
  private async stopRecorded(sessionIds: readonly string[]): Promise<boolean> {
    const recorded = new Map<number, { startedAt: number; command: string }>()
    for (const sessionId of sessionIds) {
      for (const process of this.tracked.get(sessionId)?.values() ?? []) {
        recorded.set(process.pid, process)
      }
      for (const root of this.roots.get(sessionId)?.values() ?? []) recorded.set(root.pid, root)
    }
    if (recorded.size === 0) return true
    if (process.platform === 'win32') {
      // `taskkill /T` walks the tree itself and Windows exposes no environment to
      // adopt from, so only the recorded commands need filtering here.
      const pids = [...recorded].flatMap(([pid, entry]) =>
        isSharedDaemon(entry.command) ? [] : [pid]
      )
      await Promise.allSettled(pids.map((pid) => this.killTree(pid)))
      return true
    }
    let snapshot: ProcessSnapshotEntry[]
    try {
      snapshot = await this.snapshotter()
    } catch (error) {
      Logger.error('Processes were left running: the process table could not be read', error)
      return false
    }
    const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
    const pids = [...recorded].flatMap(([pid, { startedAt }]) => {
      const current = byPid.get(pid)
      if (!current || isRecycledPid(current.startedAt, startedAt)) return []
      return isUnderSharedDaemon(pid, byPid) ? [] : [pid]
    })
    await Promise.allSettled(pids.map((pid) => this.killTree(pid, false, snapshot)))
    return true
  }

  /**
   * Reap harness processes left orphaned by an unclean previous run (crash,
   * force-quit, or the shutdown failsafe). Only ever kills processes the app
   * actually spawned: journaled roots verified as owned (marker env present) or
   * orphaned, plus   on Linux   any orphaned process still carrying the marker
   * so a dev server whose root already died is reclaimed too. A user's own
   * external claude-code/opencode session is never touched.
   *
   * A journaled root with a still-living parent is never killed: it is owned by
   * a live process   usually another running app instance (the journal lives in
   * shared userData, and a sibling instance that exits while this one runs
   * leaves its roots journaled behind). Reaping such a root would SIGTERM a
   * harness the sibling is actively using, so the entry stays journaled for a
   * future launch once that instance is gone.
   *
   * The journal names each entry's instance. Nothing is reaped while that instance
   * runs, and an adopted entry with no instance is forgotten unsignalled: older
   * versions adopted other instances' processes, so it proves nothing.
   *
   * Pass `requireOwnershipProof` from the repeated running sweep
   * (`ChatEngine.sweepOrphanedProcesses`) so only marker-verified roots are
   * signalled; an unproven entry stays journaled for the next launch instead.
   */
  async reapOrphans(options: ReapOrphansOptions = {}): Promise<ReapOrphansResult> {
    if (!this.journal) return { killed: [], skipped: [] }
    const roots = await this.journal.load()
    // Nothing journaled means nothing to reap, and the snapshot below reads the
    // whole process table: skip it rather than paying for it to iterate nothing.
    if (roots.length === 0) return { killed: [], skipped: [] }
    const snapshot = await this.snapshotter().catch(() => [])
    const alive = new Set(snapshot.map((entry) => entry.pid))
    const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
    const killed: number[] = []
    const skipped: number[] = []

    for (const root of roots) {
      if (!alive.has(root.pid)) {
        skipped.push(root.pid)
        this.journal.unregister(root.pid)
        continue
      }
      const parentPid = byPid.get(root.pid)?.parentPid ?? 0
      // A journaled root with a live parent is not an orphan: it still belongs
      // to whoever spawned it (typically another running CodeInOven instance,
      // since the journal is shared via userData and a sibling instance skips
      // chat-engine disposal on shutdown). Killing it would SIGTERM a harness
      // that instance is actively using. Only orphaned roots are crash
      // leftovers and safe to reap.
      if (!this.isOrphaned(parentPid, alive)) {
        skipped.push(root.pid)
        // Keep the entry journaled: if the owning instance later dies uncleanly,
        // a future launch must still be able to reap it.
        continue
      }
      if (root.owner && isOwnerRunning(root.owner, alive)) {
        skipped.push(root.pid)
        continue
      }
      if ((root.adopted && !root.owner) || isUnderSharedDaemon(root.pid, byPid)) {
        skipped.push(root.pid)
        this.journal.unregister(root.pid)
        continue
      }
      const ownership = (await this.readOwnership([root.pid])).get(root.pid)
      const marker = ownership?.owned ?? null
      if (marker === true && (ownership?.instance ?? null) !== (root.owner ?? null)) {
        // Another instance's stamp: the OS handed this pid on since it was journaled.
        skipped.push(root.pid)
        this.journal.unregister(root.pid)
        continue
      }
      if (options.requireOwnershipProof) {
        // An adopted daemon (see OwnedRoot.adopted) is an app-marked orphan too,
        // but the running app may be talking to it; only a launch reaps those.
        // The exception is OpenCode's own managed service, which the app caused
        // but never uses: it is reaped so a historical leak does not outlive the
        // fix that stopped spawning it.
        if (root.adopted === true && !isOpenCodeServiceDaemon(root.command)) continue
        if (marker === true) {
          await this.killTree(root.pid, false, snapshot)
          killed.push(root.pid)
          this.journal.unregister(root.pid)
        } else if (marker === false) {
          // The live process carries no ownership marker, so this journaled pid
          // was recycled by the OS. Forget the entry instead of signalling it.
          this.journal.unregister(root.pid)
        }
        // `null` means the platform cannot tell: keep the entry journaled for a
        // launch that can fall back to the orphan check.
        continue
      }

      // Orphaned is established above, so an unreadable environment still reaps.
      if (marker !== false) {
        await this.killTree(root.pid, false, snapshot)
        killed.push(root.pid)
        this.journal.unregister(root.pid)
      } else {
        skipped.push(root.pid)
        this.journal.unregister(root.pid)
      }
    }

    if (killed.length > 0 || skipped.length > 0) {
      await this.journal.flush()
    }

    // Linux-only sweep: `/proc/<pid>/environ` lets us read another process's env
    // reliably, so sweep every orphaned process carrying the marker. This reclaims
    // a dev server whose root already died   including one leaked after a *clean*
    // shutdown (when the journal is already cleared). On macOS/Windows env is not
    // readable, so we rely on the journaled, orphaned roots above (which covers
    // the common crash-leak of a live `opencode serve` root). The repeating sweep
    // skips it: an adopted daemon (for example an `adb` fork-server) is an
    // app-marked orphan too, so a launch-only reclaim of those is deliberate.
    if (process.platform === 'linux' && !options.requireOwnershipProof) {
      const journaledOwners = new Set(roots.flatMap((root) => root.owner ?? []))
      const markedOrphans = await this.sweepMarkedOrphans(snapshot, alive, journaledOwners)
      for (const pid of markedOrphans) {
        if (killed.includes(pid)) continue
        await this.killTree(pid, false, snapshot)
        killed.push(pid)
      }
    }

    return { killed, skipped }
  }

  /** Orphans stamped by a dead instance of this data root, which the journal names. */
  private async sweepMarkedOrphans(
    snapshot: ProcessSnapshotEntry[],
    alive: ReadonlySet<number>,
    journaledOwners: ReadonlySet<string>
  ): Promise<number[]> {
    const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
    const orphans = snapshot.filter(
      (entry) => this.isOrphaned(entry.parentPid, alive) && !isUnderSharedDaemon(entry.pid, byPid)
    )
    const ownership = await this.readOwnership(orphans.map((entry) => entry.pid))
    return orphans.flatMap(({ pid }) => {
      const instance = ownership.get(pid)?.instance
      if (!instance || !journaledOwners.has(instance) || isOwnerRunning(instance, alive)) return []
      return [pid]
    })
  }

  private isOrphaned(parentPid: number, alive: ReadonlySet<number>): boolean {
    return parentPid <= 1 || !alive.has(parentPid)
  }

  /**
   * Best-effort ownership probe for another process's environment. Returns the
   * app marker state and, when present, the CodeInOven session id that spawned
   * it. macOS exposes the environment of same-user processes via `ps -E`;
   * Linux via `/proc/<pid>/environ`; Windows cannot reveal it, so the result is
   * `null` there.
   */
  private async readOwnership(pids: readonly number[]): Promise<Map<number, ProcessOwnership>> {
    const result = new Map<number, ProcessOwnership>()
    if (pids.length === 0) return result
    if (process.platform === 'darwin') {
      for (let index = 0; index < pids.length; index += OWNERSHIP_PROBE_CHUNK) {
        const chunk = pids.slice(index, index + OWNERSHIP_PROBE_CHUNK)
        try {
          const { stdout } = await execFileAsync(
            'ps',
            // `-ww`: the environment follows the arguments, so a clipped line loses the stamp.
            ['-E', '-ww', '-p', chunk.map(String).join(',')],
            { timeout: PORT_SCAN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }
          )
          for (const line of stdout.split(/\r?\n/u)) {
            const pid = Number(line.trim().split(/\s+/u)[0])
            if (!Number.isFinite(pid) || pid <= 0 || result.has(pid)) continue
            // The environment is printed after the arguments, so the last match is the
            // real one. No regular expression: this reads every environment on the machine.
            const valueOf = (name: string): string | null => {
              const at = line.lastIndexOf(` ${name}=`)
              if (at < 0) return null
              const from = at + name.length + 2
              const end = line.indexOf(' ', from)
              return line.slice(from, end < 0 ? undefined : end) || null
            }
            result.set(
              pid,
              ownershipFrom(valueOf(OWNED_PROCESS_MARKER), valueOf(OWNED_SESSION_MARKER))
            )
          }
        } catch {
          // Probes are best-effort; missing rows are treated as unknown.
        }
      }
      return result
    }
    if (process.platform !== 'linux') return result
    const ownerships = await Promise.all(
      pids.map(async (pid): Promise<[number, ProcessOwnership]> => {
        try {
          const environ = await readFile(`/proc/${pid}/environ`, 'utf8')
          const entries = environ.split('\0')
          const valueOf = (name: string): string | null =>
            entries.find((entry) => entry.startsWith(`${name}=`))?.slice(name.length + 1) ?? null
          return [pid, ownershipFrom(valueOf(OWNED_PROCESS_MARKER), valueOf(OWNED_SESSION_MARKER))]
        } catch {
          return [pid, { owned: null, instance: null, sessionId: null }]
        }
      })
    )
    return new Map(ownerships)
  }

  /**
   * Working directory of each pid, best effort.
   *
   * A daemon that re-parents to launchd (the adb fork-server) is adopted from
   * the process snapshot, and that snapshot carries no cwd field on any
   * platform, so this is the only way its row can show where it was launched,
   * and the only handle the task manager has for attributing it to a project.
   * One batched `lsof` answers the whole adoption batch on macOS and the BSDs;
   * Linux answers from `/proc/<pid>/cwd` without spawning anything. Windows has
   * no read path for another process's cwd, so adopted rows there keep none.
   */
  private async resolveWorkingDirectories(pids: readonly number[]): Promise<Map<number, string>> {
    const result = new Map<number, string>()
    if (pids.length === 0) return result
    if (process.platform === 'linux') {
      await Promise.all(
        pids.map(async (pid): Promise<void> => {
          try {
            const cwd = await readlink(`/proc/${pid}/cwd`)
            if (cwd) result.set(pid, cwd)
          } catch {
            // The process exited, or its directory is unreadable: leave it unknown.
          }
        })
      )
      return result
    }
    if (process.platform === 'win32') return result
    for (let index = 0; index < pids.length; index += CWD_PROBE_CHUNK) {
      const chunk = pids.slice(index, index + CWD_PROBE_CHUNK)
      let stdout: string
      try {
        stdout = (
          await execFileAsync('lsof', ['-a', '-d', 'cwd', '-F', 'pn', '-p', chunk.join(',')], {
            timeout: CWD_PROBE_TIMEOUT_MS,
            windowsHide: true
          })
        ).stdout
      } catch (error) {
        // `lsof` exits non-zero as soon as one pid has already exited; the rows
        // it did match are still on stdout.
        const failed = record(error)
        stdout = typeof failed?.['stdout'] === 'string' ? failed['stdout'] : ''
      }
      let currentPid = 0
      for (const line of stdout.split(/\r?\n/u)) {
        if (line.startsWith('p')) {
          currentPid = Number(line.slice(1))
        } else if (line.startsWith('n') && currentPid > 0) {
          const cwd = line.slice(1)
          if (cwd) result.set(currentPid, cwd)
        }
      }
    }
    return result
  }

  private sessionsForThread(projectId: string, threadId: string): string[] {
    return [...this.owners.entries()].flatMap(([sessionId, owner]) =>
      owner.projectId === projectId && owner.threadId === threadId ? [sessionId] : []
    )
  }

  private ownsProcess(pid: number): boolean {
    for (const processes of this.tracked.values()) {
      if (processes.has(pid)) return true
    }
    for (const roots of this.roots.values()) {
      if (roots.has(pid)) return true
    }
    return false
  }

  private async scan(options: { force?: boolean } = {}): Promise<void> {
    if (this.scanInFlight) return this.scanInFlight
    if (!options.force && Date.now() - this.lastScanAt < SCAN_MIN_INTERVAL_MS) return
    this.lastScanAt = Date.now()
    const request = this.performScan()
    this.scanInFlight = request
    try {
      await request
    } finally {
      if (this.scanInFlight === request) this.scanInFlight = null
    }
  }

  private async performScan(): Promise<void> {
    try {
      const snapshot = await this.snapshotter()
      this.lastSnapshot = snapshot
      const currentByPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
      const childrenByParent = childrenIndex(snapshot)

      await this.adoptMarkedOrphans(snapshot, currentByPid, childrenByParent)

      const changedOwners = new Map<string, ProcessOwner>()
      const sessionIds = new Set([...this.roots.keys(), ...this.tracked.keys()])
      for (const sessionId of sessionIds) {
        const isAppScope = sessionId === APP_SCOPE
        const sessionRoots = this.roots.get(sessionId) ?? new Map<number, HarnessRoot>()
        let sessionProcesses = this.tracked.get(sessionId)
        if (!sessionProcesses) {
          sessionProcesses = new Map()
          this.tracked.set(sessionId, sessionProcesses)
        }
        let changed = false
        for (const root of sessionRoots.values()) {
          if (isRecycledPid(currentByPid.get(root.pid)?.startedAt, root.startedAt)) {
            // The root exited and its pid is another process's now, children included.
            sessionRoots.delete(root.pid)
            this.journal?.unregister(root.pid)
            continue
          }
          for (const descendant of descendantsOf(root.pid, childrenByParent)) {
            if (sessionProcesses.has(descendant.pid)) continue
            sessionProcesses.set(descendant.pid, {
              pid: descendant.pid,
              parentPid: descendant.parentPid,
              command: descendant.command,
              startedAt: Date.now(),
              scope: isAppScope ? 'app' : 'thread',
              sessionId,
              cwd: root.cwd
            })
            changed = true
          }
          if (!currentByPid.has(root.pid)) {
            sessionRoots.delete(root.pid)
            this.journal?.unregister(root.pid)
          }
        }
        for (const [pid, tracked] of sessionProcesses) {
          const current = currentByPid.get(pid)
          if (current && !isRecycledPid(current.startedAt, tracked.startedAt)) {
            tracked.command = current.command
            tracked.parentPid = current.parentPid
          } else {
            sessionProcesses.delete(pid)
            this.journal?.unregister(pid)
            changed = true
          }
        }
        if (sessionRoots.size === 0) this.roots.delete(sessionId)
        if (sessionProcesses.size === 0) this.tracked.delete(sessionId)
        const owner = this.owners.get(sessionId)
        if (changed && owner) changedOwners.set(`${owner.projectId}:${owner.threadId}`, owner)
      }
      for (const owner of changedOwners.values()) {
        broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
      }
    } catch (error) {
      Logger.dev('Agent process scan failed:', error)
    }
  }

  /**
   * Adopt app-owned processes that detached from every tracked harness tree.
   *
   * A process a harness spawns can outlive the tree that explains it: the adb
   * server re-parents to launchd the moment the `adb` client first starts it,
   * and a background server started with `nohup` (a training server, a dev
   * server) keeps running under a wrapper launchd inherits once the harness is
   * gone. Neither appears under a live root's descendant tree, so they are
   * adopted here instead: anything the app can prove it owns and no live root
   * reaches becomes a runtime the task manager lists, the user can end, and the
   * journal reaps.
   *
   * Ownership is proven by this instance's id in the process environment, which it
   * stamps on every harness spawn and children inherit. Another instance's stamp, or
   * an older version's, is never adopted, whatever its parent: adoption is what
   * makes a process this instance's to stop. Inheritance covers a
   * child macOS cannot judge on its own: the environment of a process running a
   * platform binary (`/bin/bash`, `/bin/sleep`) is unreadable, so a `/bin/bash`
   * worker under a marked server is adopted because its parent is. A platform
   * binary wrapper that launched a marked server is not provable from below and
   * stays out, which is the one case this cannot see. Two exclusions keep
   * adoption from stealing rows the app already owns elsewhere: the app's own
   * process family (registered services such as the gateway, the llama server,
   * and MCP children are its descendants and already have service rows), and a
   * process whose readable session marker names a session this instance does not
   * hold, unless it is detached.
   *
   * Live children of a harness (short-lived `adb` clients, dev servers, etc.)
   * are reachable from their root, already tracked as descendants, and never
   * candidates. On Windows, where the environment of another process cannot be
   * read at all, only the uniquely fingerprintable adb server daemon is adopted.
   */
  private async adoptMarkedOrphans(
    snapshot: ProcessSnapshotEntry[],
    currentByPid: ReadonlyMap<number, ProcessSnapshotEntry>,
    childrenByParent: ReadonlyMap<number, ProcessSnapshotEntry[]>
  ): Promise<void> {
    if (currentByPid.size === 0) return
    const liveSessions = [...this.roots.entries()].flatMap(([sessionId, sessionRoots]) =>
      [...sessionRoots.keys()].some((pid) => currentByPid.has(pid)) ? [sessionId] : []
    )
    // Everything a live root reaches is tracked by the descendant walk that
    // follows, and every known row is already tracked, so neither is a candidate.
    const knownPids = new Set<number>()
    for (const processes of this.tracked.values()) {
      for (const pid of processes.keys()) knownPids.add(pid)
    }
    const reachable = new Set<number>()
    for (const roots of this.roots.values()) {
      for (const root of roots.values()) {
        if (!currentByPid.has(root.pid)) continue
        knownPids.add(root.pid)
        reachable.add(root.pid)
        for (const descendant of descendantsOf(root.pid, childrenByParent)) {
          reachable.add(descendant.pid)
        }
      }
    }
    const appFamily = this.appProcessFamily(currentByPid, childrenByParent)
    const alive = new Set(currentByPid.keys())
    const isWindows = process.platform === 'win32'
    const adbServerPattern = /\badb\b[^\0]*\bfork-server\b/u
    const candidates = snapshot.filter(
      (entry) =>
        !knownPids.has(entry.pid) &&
        !reachable.has(entry.pid) &&
        !appFamily.has(entry.pid) &&
        // OpenCode's managed service daemon is app-marked because the app's own
        // probe triggered it, but the app never talks to it (it spawns private
        // servers instead), so it is not adopted as an app runtime.
        !isOpenCodeServiceDaemon(entry.command) &&
        // Windows cannot read another process's environment; only adopt the
        // unambiguously fingerprintable adb server daemon there.
        (!isWindows || adbServerPattern.test(entry.command))
    )
    if (candidates.length === 0) return
    const candidatePids = new Set(candidates.map((entry) => entry.pid))
    const ownership = await this.readOwnership(candidates.map((entry) => entry.pid))
    // A process is owned when its own environment carries this instance's id, and so
    // is a child of an owned process: the environment is inherited, so a platform
    // binary a marked server spawns is adopted even though its own environment is
    // unreadable.
    const adoptable = new Map<number, string | null>()
    for (const entry of candidates) {
      const owner = ownership.get(entry.pid)
      if (owner?.instance === INSTANCE_OWNER_ID) adoptable.set(entry.pid, owner.sessionId)
    }
    const queue = [...adoptable.keys()]
    while (queue.length > 0) {
      const pid = queue.pop()
      if (pid === undefined) continue
      const sessionId = adoptable.get(pid) ?? null
      for (const child of childrenByParent.get(pid) ?? []) {
        if (!candidatePids.has(child.pid) || adoptable.has(child.pid)) continue
        const stamp = ownership.get(child.pid)?.instance
        if (stamp && stamp !== INSTANCE_OWNER_ID) continue
        adoptable.set(child.pid, ownership.get(child.pid)?.sessionId ?? sessionId)
        queue.push(child.pid)
      }
    }
    if (adoptable.size === 0) return
    // Resolve where each adoptable process was launched before recording it. An
    // adopted row has no session to fall back on, so this cwd is both the path
    // its row shows and the handle the task manager attributes it to a project
    // with. One batched probe covers the whole adoption batch.
    const adoptedCwds = await this.resolveWorkingDirectories([...adoptable.keys()])
    // Journal an adopted daemon only when no entry exists yet: an entry written
    // by the process that spawned it carries the real command and cwd and stays a
    // swept root, while overwriting it as "adopted" would hide it from the
    // running orphan sweep.
    const existingRoots = (await this.journal?.load()) ?? []
    const journalled = new Set(
      existingRoots.flatMap((root) => (root.owner === INSTANCE_OWNER_ID ? [root.pid] : []))
    )
    const adoptedScopes = new Set<string>()
    for (const entry of candidates) {
      if (!adoptable.has(entry.pid)) continue
      const sessionId = adoptable.get(entry.pid) ?? null
      const claimed = sessionId !== null && this.owners.has(sessionId)
      // A process that still has a live parent and carries a session this
      // instance no longer holds is still that parent's. Only a detached one is adopted.
      if (sessionId !== null && !claimed && !this.isOrphaned(entry.parentPid, alive)) continue
      const scope =
        claimed && sessionId !== null
          ? sessionId
          : liveSessions.length === 1
            ? liveSessions[0]
            : APP_SCOPE
      let sessionProcesses = this.tracked.get(scope)
      if (!sessionProcesses) {
        sessionProcesses = new Map()
        this.tracked.set(scope, sessionProcesses)
      }
      if (sessionProcesses.has(entry.pid)) continue
      const cwd = adoptedCwds.get(entry.pid) ?? null
      sessionProcesses.set(entry.pid, {
        pid: entry.pid,
        parentPid: entry.parentPid,
        command: entry.command,
        startedAt: Date.now(),
        scope: scope === APP_SCOPE ? 'app' : 'thread',
        sessionId: scope,
        cwd
      })
      // Journal the adopted daemon so reapOrphans can still kill it after the
      // app closes without a clean shutdown.
      if (this.journal && !journalled.has(entry.pid)) {
        this.journal.registerAdopted(entry.pid, entry.command, cwd ?? '')
        journalled.add(entry.pid)
      }
      adoptedScopes.add(scope)
    }
    for (const scope of adoptedScopes) {
      const owner = this.owners.get(scope)
      if (owner) broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
    }
  }

  /**
   * Pids that belong to the app's own process structure: this main process, the
   * processes that launched it, and every process below it. A registered service
   * (the utility gateway, the llama server, an MCP child) is a descendant of this
   * process and already has its own row, so adoption must never duplicate it.
   */
  private appProcessFamily(
    currentByPid: ReadonlyMap<number, ProcessSnapshotEntry>,
    childrenByParent: ReadonlyMap<number, ProcessSnapshotEntry[]>
  ): Set<number> {
    const family = new Set<number>()
    const pending = [process.pid]
    while (pending.length > 0) {
      const pid = pending.pop()
      if (pid === undefined || pid <= 0 || family.has(pid)) continue
      family.add(pid)
      for (const child of childrenByParent.get(pid) ?? []) pending.push(child.pid)
    }
    let ancestor = currentByPid.get(process.pid)?.parentPid ?? 0
    while (ancestor > 1 && !family.has(ancestor)) {
      family.add(ancestor)
      ancestor = currentByPid.get(ancestor)?.parentPid ?? 0
    }
    return family
  }

  /**
   * End a process and what it started, except a shared daemon somewhere below it
   * (an emulator an agent booted) and that daemon's own children.
   */
  private async killTree(
    pid: number,
    force = false,
    known?: readonly ProcessSnapshotEntry[]
  ): Promise<void> {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
          windowsHide: true
        })
      } catch (error) {
        const snapshot = await this.snapshotter().catch(() => null)
        if (!snapshot || snapshot.some((entry) => entry.pid === pid)) throw error
      }
      return
    }

    const snapshot = known ?? (await this.snapshotter().catch(() => []))
    const byPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
    const tree = descendantsOf(pid, childrenIndex(snapshot))
      .filter((entry) => !isUnderSharedDaemon(entry.pid, byPid, pid))
      .reverse()
    const targets = [...tree, { pid }]
    if (force) {
      // No grace period: terminate every process in the tree immediately.
      for (const process of targets) {
        try {
          globalThis.process.kill(process.pid, 'SIGKILL')
        } catch (error) {
          if (!isMissingProcessError(error)) throw error
        }
      }
      return
    }
    for (const process of targets) {
      try {
        globalThis.process.kill(process.pid, 'SIGTERM')
      } catch {
        // The process already exited.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_EXIT_GRACE_MS))
    const failedPids: number[] = []
    for (const process of targets) {
      try {
        globalThis.process.kill(process.pid, 0)
      } catch (error) {
        if (!isMissingProcessError(error)) failedPids.push(process.pid)
        continue
      }
      try {
        globalThis.process.kill(process.pid, 'SIGKILL')
      } catch (error) {
        if (!isMissingProcessError(error)) failedPids.push(process.pid)
      }
    }
    if (failedPids.length > 0) {
      throw new Error(`Could not stop app-owned processes: ${failedPids.join(', ')}`)
    }
  }
}
