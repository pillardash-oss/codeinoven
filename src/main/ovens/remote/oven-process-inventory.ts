/**
 * The processes one Oven's service is responsible for, and how to end one.
 *
 * The desktop task manager lists what this app started, never the whole
 * machine, and an Oven follows the same rule: every process descending from the
 * service daemon (harness runs and whatever they spawned) is listed, and only
 * those may be ended. A pid outside that tree is refused, so the task manager
 * can never be used to kill an unrelated process on someone's server.
 */
import { execFile } from 'node:child_process'
import { readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { OvenProcess } from '../../../lib/ovens'

const run = promisify(execFile)

/** Longest a process listing may take before the request gives up. */
const LIST_TIMEOUT_MS = 8_000

/** One row of the machine's process table, before the tree is filtered. */
interface ProcessRow {
  pid: number
  parentPid: number
  command: string
  startedAt: number
  cpuPercent: number | null
  memoryBytes: number | null
}

/** `ps` elapsed time (`[[dd-]hh:]mm:ss`) in seconds. */
function elapsedSeconds(value: string): number {
  const [days, clock] = value.includes('-') ? value.split('-', 2) : ['0', value]
  const parts = clock.split(':').map(Number)
  while (parts.length < 3) parts.unshift(0)
  const [hours, minutes, seconds] = parts
  return Number(days) * 86_400 + hours * 3_600 + minutes * 60 + seconds
}

/** Every process on a POSIX machine, through `ps`, which Linux and macOS share. */
async function posixRows(): Promise<ProcessRow[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,etime=,command='], {
    timeout: LIST_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024
  })
  const now = Date.now()
  const rows: ProcessRow[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
    if (!match) continue
    rows.push({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      cpuPercent: Number(match[3]),
      memoryBytes: Number(match[4]) * 1024,
      startedAt: now - elapsedSeconds(match[5]) * 1000,
      command: match[6].trim()
    })
  }
  return rows
}

/** Every process on Windows, through CIM. CPU is not sampled there. */
async function windowsRows(): Promise<ProcessRow[]> {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ p=$_.ProcessId; pp=$_.ParentProcessId; m=$_.WorkingSetSize; s=if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }; c=if ($_.CommandLine) { $_.CommandLine } else { $_.Name } } } | ConvertTo-Json -Compress'
  const { stdout } = await run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { timeout: LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
  )
  const parsed: unknown = JSON.parse(stdout.trim() || '[]')
  const list = Array.isArray(parsed) ? parsed : [parsed]
  return list.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    if (typeof item.p !== 'number' || typeof item.pp !== 'number') return []
    return [
      {
        pid: item.p,
        parentPid: item.pp,
        command: typeof item.c === 'string' ? item.c : '',
        startedAt: typeof item.s === 'number' ? item.s : 0,
        cpuPercent: null,
        memoryBytes: typeof item.m === 'number' ? item.m : null
      }
    ]
  })
}

/** The rows under `rootPid`, the root itself excluded. */
function descendantsOf(rows: readonly ProcessRow[], rootPid: number): ProcessRow[] {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pid === row.parentPid) continue
    const siblings = children.get(row.parentPid) ?? []
    siblings.push(row)
    children.set(row.parentPid, siblings)
  }
  const found: ProcessRow[] = []
  const queue = [rootPid]
  const seen = new Set<number>([rootPid])
  while (queue.length > 0) {
    const parent = queue.shift() as number
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      found.push(child)
      queue.push(child.pid)
    }
  }
  return found
}

/** Where a Linux process runs, when `/proc` will say. Other platforms answer null. */
async function workingDirectory(pid: number): Promise<string | null> {
  if (process.platform !== 'linux') return null
  return await readlink(join('/proc', String(pid), 'cwd')).catch(() => null)
}

async function treeUnder(rootPid: number): Promise<ProcessRow[]> {
  const rows = process.platform === 'win32' ? await windowsRows() : await posixRows()
  return descendantsOf(rows, rootPid)
}

/** Every process the service at `rootPid` is responsible for. */
export async function listOvenProcesses(rootPid: number): Promise<OvenProcess[]> {
  const tree = await treeUnder(rootPid)
  return await Promise.all(
    tree.map(async (row) => ({ ...row, cwd: await workingDirectory(row.pid) }))
  )
}

/**
 * End one process the service is responsible for.
 *
 * A polite end asks the process to exit (SIGTERM, or `taskkill` without `/F`);
 * a forced one does not ask. Either is refused for a pid outside the tree.
 */
export async function killOvenProcess(rootPid: number, pid: number, force: boolean): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid process id.')
  const tree = await treeUnder(rootPid)
  if (!tree.some((row) => row.pid === pid))
    throw new Error('That process is not one this Oven service runs, so it cannot be ended here.')
  if (process.platform === 'win32') {
    await run('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
      timeout: LIST_TIMEOUT_MS,
      windowsHide: true
    })
    return
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch (error) {
    // Gone between the listing and the signal is the state the caller asked for.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
}
