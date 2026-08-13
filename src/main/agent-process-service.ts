import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentRunningProcess } from '../lib/types'
import type { AgentProcessObserver } from './drivers/driver.interface'
import { Logger } from './logger'
import { broadcastAgentProcessesChanged } from './thread-events'

const execFileAsync = promisify(execFile)
const PROCESS_SCAN_INTERVAL_MS = 750
const PROCESS_EXIT_GRACE_MS = 1_500

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
}

interface TrackedProcess extends AgentRunningProcess {
  sessionId: string
}

type ProcessSnapshotter = () => Promise<ProcessSnapshotEntry[]>

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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

  constructor(private readonly snapshotter: ProcessSnapshotter = defaultSnapshotter) {}

  claimSession(sessionId: string, projectId: string, threadId: string): void {
    this.owners.set(sessionId, { projectId, threadId })
  }

  watchProcess(sessionId: string, pid: number | undefined, command: string, cwd: string): void {
    if (!pid || pid <= 0) return
    let sessionRoots = this.roots.get(sessionId)
    if (!sessionRoots) {
      sessionRoots = new Map()
      this.roots.set(sessionId, sessionRoots)
    }
    sessionRoots.set(pid, { pid, command, cwd })
    this.ensureScanner()
    void this.scan()
  }

  list(projectId: string, threadId: string): AgentRunningProcess[] {
    const unique = new Map<number, AgentRunningProcess>()
    for (const [sessionId, owner] of this.owners) {
      if (owner.projectId !== projectId || owner.threadId !== threadId) continue
      for (const process of this.tracked.get(sessionId)?.values() ?? []) {
        unique.set(process.pid, {
          pid: process.pid,
          parentPid: process.parentPid,
          command: process.command,
          startedAt: process.startedAt
        })
      }
    }
    return [...unique.values()].sort((left, right) => left.startedAt - right.startedAt)
  }

  async killProcess(projectId: string, threadId: string, pid: number): Promise<void> {
    const owned = this.sessionsForThread(projectId, threadId).some((sessionId) =>
      this.tracked.get(sessionId)?.has(pid)
    )
    if (!owned) throw new Error(`Process ${pid} is not owned by this task`)
    await this.killTree(pid)
    await this.scan()
  }

  async killThread(projectId: string, threadId: string): Promise<void> {
    const sessionIds = this.sessionsForThread(projectId, threadId)
    const pids = new Set<number>()
    for (const sessionId of sessionIds) {
      for (const process of this.tracked.get(sessionId)?.values() ?? []) pids.add(process.pid)
    }
    await Promise.allSettled([...pids].map((pid) => this.killTree(pid)))
    for (const sessionId of sessionIds) {
      this.tracked.delete(sessionId)
    }
    broadcastAgentProcessesChanged(projectId, threadId)
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
    await Promise.allSettled([...pids].map((pid) => this.killTree(pid)))
    this.tracked.clear()
    this.roots.clear()
    this.owners.clear()
    for (const owner of owners.values()) {
      broadcastAgentProcessesChanged(owner.projectId, owner.threadId)
    }
    this.stopScanner()
  }

  private sessionsForThread(projectId: string, threadId: string): string[] {
    return [...this.owners.entries()].flatMap(([sessionId, owner]) =>
      owner.projectId === projectId && owner.threadId === threadId ? [sessionId] : []
    )
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
      const sessionIds = new Set([...this.roots.keys(), ...this.tracked.keys()])
      for (const sessionId of sessionIds) {
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
              ...descendant,
              sessionId,
              startedAt: Date.now()
            })
            changed = true
          }
          if (!currentByPid.has(root.pid)) sessionRoots.delete(root.pid)
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

  private async killTree(pid: number): Promise<void> {
    if (process.platform === 'win32') {
      try {
        await execFileAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true
        })
      } catch {
        // The process may have exited between the UI action and taskkill.
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
    for (const process of [...tree, { pid }]) {
      try {
        globalThis.process.kill(process.pid, 'SIGTERM')
      } catch {
        // The process already exited.
      }
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_EXIT_GRACE_MS))
    for (const process of [...tree, { pid }]) {
      try {
        globalThis.process.kill(process.pid, 0)
        globalThis.process.kill(process.pid, 'SIGKILL')
      } catch {
        // The process exited after SIGTERM.
      }
    }
  }
}
