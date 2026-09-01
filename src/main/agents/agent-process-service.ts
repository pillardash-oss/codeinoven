import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { AgentRunningProcess, TaskManagerProcess } from '../../lib/types'
import type { AgentProcessObserver } from '../drivers/driver.interface'
import { OWNED_PROCESS_MARKER } from '../drivers/cli-environment'
import { Logger } from '../system/logger'
import { OwnedProcessJournal } from '../system/owned-process-journal'
import { broadcastAgentProcessesChanged } from '../chat/thread-events'

const execFileAsync = promisify(execFile)
const PROCESS_SCAN_INTERVAL_MS = 750
const PROCESS_EXIT_GRACE_MS = 1_500
const PORT_SCAN_TIMEOUT_MS = 2_000
/** Key under which app-wide roots (e.g. the shared opencode server) are tracked. */
const APP_SCOPE = '__codeinoven_app_scope__'

interface ProcessSnapshotEntry {
  pid: number
  parentPid: number
  command: string
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
export interface ReapOrphansResult {
  killed: number[]
  skipped: number[]
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
    return [{ pid, parentPid, command }]
  })
}

async function snapshotWindowsProcesses(): Promise<ProcessSnapshotEntry[]> {
  const script = [
    'Get-CimInstance Win32_Process',
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine',
    'ConvertTo-Json -Compress'
  ].join(' | ')
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
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command='])
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/u)
    if (!match) return []
    return [
      {
        pid: Number(match[1]),
        parentPid: Number(match[2]),
        command: match[3]?.trim() || `Process ${match[1]}`
      }
    ]
  })
}

async function defaultSnapshotter(): Promise<ProcessSnapshotEntry[]> {
  return process.platform === 'win32' ? snapshotWindowsProcesses() : snapshotUnixProcesses()
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
  private scanTimer: ReturnType<typeof setInterval> | null = null
  private scanInFlight = false
  private journal: OwnedProcessJournal | null = null

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
    this.ensureScanner()
    void this.scan()
  }

  list(projectId: string, threadId: string): AgentRunningProcess[] {
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
    // App-scoped processes (descendants of a shared/pooled harness like the
    // opencode server) are surfaced alongside the thread's own processes so the
    // user can see and kill them, but always labeled `app` so it is clear they
    // are NOT tied to this thread alone.
    for (const process of this.tracked.get(APP_SCOPE)?.values() ?? []) {
      unique.set(process.pid, {
        pid: process.pid,
        parentPid: process.parentPid,
        command: process.command,
        startedAt: process.startedAt,
        scope: 'app'
      })
    }
    return [...unique.values()].sort((left, right) => left.startedAt - right.startedAt)
  }

  async killProcess(projectId: string, threadId: string, pid: number): Promise<void> {
    if (!this.ownsProcess(pid)) throw new Error(`Process ${pid} is not owned by this app`)
    await this.killTree(pid, false)
    await this.scan()
  }

  /**
   * Global kill used by the task manager: targets any app-owned pid regardless
   * of project/thread. `force` skips the graceful SIGTERM stage and escalates
   * straight to SIGKILL (or `taskkill /F` on Windows).
   */
  async killProcessGlobal(pid: number, force: boolean): Promise<void> {
    if (!this.ownsProcess(pid)) throw new Error(`Process ${pid} is not owned by this app`)
    await this.killTree(pid, force)
    await this.scan()
  }

  /**
   * App-wide process list for the task manager. Enumerates every owned harness
   * root and descendant across all sessions (thread-scoped and app-scoped),
   * attaching the project/thread that owns each, its working directory, and the
   * TCP ports it is listening on (best-effort OS detection).
   */
  async listAll(): Promise<TaskManagerProcess[]> {
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
          ports: portsByPid.get(root.pid) ?? []
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
          ports: portsByPid.get(process.pid) ?? []
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
        ports: portsByPid.get(root.pid) ?? []
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
        ports: portsByPid.get(process.pid) ?? []
      })
    }
    return [...unique.values()].sort((left, right) => left.startedAt - right.startedAt)
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
    const pids = new Set<number>()
    const appScopedPids = new Set<number>()
    for (const sessionId of sessionIds) {
      for (const process of this.tracked.get(sessionId)?.values() ?? []) pids.add(process.pid)
      for (const root of this.roots.get(sessionId)?.values() ?? []) pids.add(root.pid)
    }
    for (const process of this.tracked.get(APP_SCOPE)?.values() ?? []) {
      appScopedPids.add(process.pid)
      pids.add(process.pid)
    }
    await Promise.all([...pids].map((pid) => this.killTree(pid)))
    for (const sessionId of sessionIds) {
      this.tracked.delete(sessionId)
      for (const root of this.roots.get(sessionId)?.values() ?? []) {
        this.journal?.unregister(root.pid)
      }
      this.roots.delete(sessionId)
    }
    const appProcesses = this.tracked.get(APP_SCOPE)
    for (const pid of appScopedPids) appProcesses?.delete(pid)
    if (appProcesses?.size === 0) this.tracked.delete(APP_SCOPE)

    const changedOwners = new Map<string, ProcessOwner>()
    changedOwners.set(`${projectId}:${threadId}`, { projectId, threadId })
    if (appScopedPids.size > 0) {
      for (const owner of this.owners.values()) {
        changedOwners.set(`${owner.projectId}:${owner.threadId}`, owner)
      }
    }
    for (const owner of changedOwners.values()) {
      broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
    }
    this.stopScannerWhenIdle()
  }

  async releaseThread(projectId: string, threadId: string): Promise<void> {
    const sessionIds = this.sessionsForThread(projectId, threadId)
    await this.killThread(projectId, threadId)
    for (const sessionId of sessionIds) {
      this.roots.delete(sessionId)
      this.owners.delete(sessionId)
    }
    this.stopScannerWhenIdle()
  }

  async killAll(): Promise<void> {
    const owners = new Map(this.owners)
    const pids = new Set<number>()
    for (const processes of this.tracked.values()) {
      for (const process of processes.values()) pids.add(process.pid)
    }
    for (const roots of this.roots.values()) {
      for (const root of roots.values()) pids.add(root.pid)
    }
    await Promise.allSettled([...pids].map((pid) => this.killTree(pid)))
    this.tracked.clear()
    this.roots.clear()
    this.owners.clear()
    if (this.journal) {
      this.journal.clear()
      await this.journal.flush()
    }
    for (const owner of owners.values()) {
      broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
    }
    this.stopScanner()
  }

  /**
   * Reap harness processes left orphaned by an unclean previous run (crash,
   * force-quit, or the shutdown failsafe). Only ever kills processes the app
   * actually spawned: journaled roots verified as owned (marker env present) or
   * orphaned, plus — on Linux — any orphaned process still carrying the marker
   * so a dev server whose root already died is reclaimed too. A user's own
   * external claude-code/opencode session is never touched.
   */
  async reapOrphans(): Promise<ReapOrphansResult> {
    if (!this.journal) return { killed: [], skipped: [] }
    const roots = await this.journal.load()
    const snapshot = await this.snapshotter().catch(() => [])
    const alive = new Set(snapshot.map((entry) => entry.pid))
    const parentOf = new Map(snapshot.map((entry) => [entry.pid, entry.parentPid]))
    const killed: number[] = []
    const skipped: number[] = []

    for (const root of roots) {
      if (!alive.has(root.pid)) {
        skipped.push(root.pid)
        continue
      }
      const parentPid = parentOf.get(root.pid) ?? 0
      const owned = await this.isOwnedOrOrphaned(root.pid, parentPid, alive)
      if (owned) {
        await this.killTree(root.pid)
        killed.push(root.pid)
      } else {
        skipped.push(root.pid)
      }
    }

    if (roots.length > 0) {
      this.journal.clear()
      await this.journal.flush()
    }

    // Linux-only sweep: `/proc/<pid>/environ` lets us read another process's env
    // reliably, so sweep every orphaned process carrying the marker. This reclaims
    // a dev server whose root already died — including one leaked after a *clean*
    // shutdown (when the journal is already cleared). On macOS/Windows env is not
    // readable, so we rely on the journaled, orphaned roots above (which covers
    // the common crash-leak of a live `opencode serve` root).
    if (process.platform === 'linux') {
      const markedOrphans = await this.sweepMarkedOrphans(snapshot, alive)
      for (const pid of markedOrphans) {
        if (killed.includes(pid)) continue
        await this.killTree(pid)
        killed.push(pid)
      }
    }

    return { killed, skipped }
  }

  private async sweepMarkedOrphans(
    snapshot: ProcessSnapshotEntry[],
    alive: ReadonlySet<number>
  ): Promise<number[]> {
    const found: number[] = []
    for (const entry of snapshot) {
      if (!this.isOrphaned(entry.parentPid, alive)) continue
      if ((await this.processHasMarker(entry.pid)) !== true) continue
      found.push(entry.pid)
    }
    return found
  }

  private async isOwnedOrOrphaned(
    pid: number,
    parentPid: number,
    alive: ReadonlySet<number>
  ): Promise<boolean> {
    const marker = await this.processHasMarker(pid)
    if (marker === true) return true
    if (marker === false) return false
    return this.isOrphaned(parentPid, alive)
  }

  private isOrphaned(parentPid: number, alive: ReadonlySet<number>): boolean {
    return parentPid <= 1 || !alive.has(parentPid)
  }

  /**
   * Best-effort check for the app's ownership marker in a process environment.
   * Returns `true`/`false` only where another process's environment is reliably
   * readable (Linux `/proc`); returns `null` when the platform cannot reveal it
   * (macOS `ps -E`, Windows) so callers fall back to the orphaned-parent check.
   */
  private async processHasMarker(pid: number): Promise<boolean | null> {
    if (process.platform !== 'linux') return null
    try {
      const environ = await readFile(`/proc/${pid}/environ`, 'utf8')
      return environ.split('\0').includes(`${OWNED_PROCESS_MARKER}=1`)
    } catch {
      return null
    }
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

  private ensureScanner(): void {
    if (this.scanTimer) return
    this.scanTimer = setInterval(() => void this.scan(), PROCESS_SCAN_INTERVAL_MS)
  }

  private stopScannerWhenIdle(): void {
    if (this.roots.size === 0 && this.tracked.size === 0) this.stopScanner()
  }

  private stopScanner(): void {
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null
  }

  private async scan(): Promise<void> {
    if (this.scanInFlight) return
    this.scanInFlight = true
    try {
      const snapshot = await this.snapshotter()
      const currentByPid = new Map(snapshot.map((entry) => [entry.pid, entry]))
      const childrenByParent = new Map<number, ProcessSnapshotEntry[]>()
      for (const entry of snapshot) {
        const children = childrenByParent.get(entry.parentPid) ?? []
        children.push(entry)
        childrenByParent.set(entry.parentPid, children)
      }

      const changedOwners = new Map<string, ProcessOwner>()
      let appScopeChanged = false
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
          if (current) {
            tracked.command = current.command
            tracked.parentPid = current.parentPid
          } else {
            sessionProcesses.delete(pid)
            changed = true
          }
        }
        if (sessionRoots.size === 0) this.roots.delete(sessionId)
        if (sessionProcesses.size === 0) this.tracked.delete(sessionId)
        const owner = this.owners.get(sessionId)
        if (changed && owner) changedOwners.set(`${owner.projectId}:${owner.threadId}`, owner)
        if (changed && isAppScope) appScopeChanged = true
      }
      if (appScopeChanged) {
        // App-scoped processes are shared across every thread, so refresh every
        // thread's Processes tab whenever the shared server's descendants change.
        const allOwners = new Map<string, ProcessOwner>()
        for (const owner of this.owners.values()) {
          allOwners.set(`${owner.projectId}:${owner.threadId}`, owner)
        }
        for (const owner of allOwners.values()) {
          broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
        }
      }
      for (const owner of changedOwners.values()) {
        broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
      }
      this.stopScannerWhenIdle()
    } catch (error) {
      Logger.dev('Agent process scan failed:', error)
    } finally {
      this.scanInFlight = false
    }
  }

  private async killTree(pid: number, force = false): Promise<void> {
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

    const snapshot = await this.snapshotter().catch(() => [])
    const childrenByParent = new Map<number, ProcessSnapshotEntry[]>()
    for (const entry of snapshot) {
      const children = childrenByParent.get(entry.parentPid) ?? []
      children.push(entry)
      childrenByParent.set(entry.parentPid, children)
    }
    const tree = descendantsOf(pid, childrenByParent).reverse()
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
