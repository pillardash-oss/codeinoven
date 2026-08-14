import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const STORE_VERSION = 1
/** Coalesce bursty root registrations/unregistrations into a single disk write. */
const FLUSH_DEBOUNCE_MS = 500
/** Hard cap so a pathological session can never grow the journal unbounded. */
const MAX_ROOTS = 512

export interface OwnedRoot {
  pid: number
  command: string
  cwd: string
}

interface OwnedRootStore {
  version: number
  roots: OwnedRoot[]
}

/**
 * Durable record of the harness root processes CodeInOven spawned this session.
 *
 * On a clean shutdown these roots are killed by {@link AgentProcessService}.
 * When the app is killed, crashes, or the shutdown failsafe force-exits, the
 * roots (and the dev servers they started) survive as orphans and hold ports.
 * The persisted journal lets a later launch reap exactly those processes without
 * ever touching a harness the user runs outside the app.
 */
export class OwnedProcessJournal {
  private readonly roots = new Map<number, OwnedRoot>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()
  private loaded = false

  constructor(private readonly filePath: string) {}

  /** Register a root process the app has spawned. */
  register(pid: number, command: string, cwd: string): void {
    if (pid <= 0) return
    this.roots.set(pid, { pid, command, cwd })
    if (this.roots.size > MAX_ROOTS) this.pruneOldest()
    this.scheduleFlush()
  }

  /** Drop a root that has exited or was cleanly killed. */
  unregister(pid: number): void {
    if (this.roots.delete(pid)) this.scheduleFlush()
  }

  /** Snapshot of the currently recorded roots. */
  list(): OwnedRoot[] {
    return [...this.roots.values()]
  }

  /** Remove every entry (used after a clean killAll). */
  clear(): void {
    this.roots.clear()
    this.scheduleFlush()
  }

  /** Load persisted roots (idempotent; called once before the first reap). */
  async load(): Promise<OwnedRoot[]> {
    if (this.loaded) return this.list()
    this.loaded = true
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = parseStore(raw)
      for (const root of parsed) this.roots.set(root.pid, root)
    } catch {
      // Missing or malformed journal is not an error — there is simply nothing to reap.
    }
    return this.list()
  }

  /** Flush any pending write now (e.g. during a clean shutdown). */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    await this.persist()
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.persist()
    }, FLUSH_DEBOUNCE_MS)
  }

  private persist(): Promise<void> {
    const payload: OwnedRootStore = { version: STORE_VERSION, roots: this.list() }
    this.writeChain = this.writeChain.then(() => atomicWrite(this.filePath, payload))
    return this.writeChain
  }

  private pruneOldest(): void {
    const sorted = [...this.roots.values()].sort((a, b) => a.pid - b.pid)
    for (const root of sorted.slice(0, this.roots.size - MAX_ROOTS)) this.roots.delete(root.pid)
  }
}

function parseStore(raw: string): OwnedRoot[] {
  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    return []
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
  const roots = (value as { roots?: unknown }).roots
  if (!Array.isArray(roots)) return []
  const parsed: OwnedRoot[] = []
  for (const entry of roots) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const { pid, command, cwd } = entry as { pid?: unknown; command?: unknown; cwd?: unknown }
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) continue
    parsed.push({
      pid,
      command: typeof command === 'string' ? command : '',
      cwd: typeof cwd === 'string' ? cwd : ''
    })
  }
  return parsed
}

async function atomicWrite(filePath: string, payload: OwnedRootStore): Promise<void> {
  const directory = dirname(filePath)
  try {
    await mkdir(directory, { recursive: true })
  } catch {
    // Directory creation is best-effort; write below will surface real failures.
  }
  const tmpPath = join(directory, `.owned-processes.${process.pid}.tmp`)
  await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, 'utf8')
  await rename(tmpPath, filePath)
}
