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
 *
 * The file lives in the shared userData/config root, so several running
 * instances write the same journal. Persistence is therefore always a
 * read-merge-write of the file on disk: a root another instance registered is
 * never erased by our write, and a root we explicitly dropped is never
 * resurrected by theirs. Writing our in-memory map wholesale would let one
 * instance's flush silently delete a sibling's root, and a root with no journal
 * entry can never be reaped   its harness process leaks as an orphan for good.
 */
export class OwnedProcessJournal {
  private readonly roots = new Map<number, OwnedRoot>()
  /** Pids this journal instance registered itself. */
  private readonly ownPids = new Set<number>()
  /** Pids this instance removed; a merge must not bring their entries back. */
  private readonly droppedPids = new Set<number>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly filePath: string) {}

  /** Register a root process the app has spawned. */
  register(pid: number, command: string, cwd: string): void {
    if (pid <= 0) return
    this.roots.set(pid, { pid, command, cwd })
    this.ownPids.add(pid)
    this.droppedPids.delete(pid)
    if (this.roots.size > MAX_ROOTS) this.pruneOldest()
    this.scheduleFlush()
  }

  /** Drop a root that has exited or was cleanly killed. */
  unregister(pid: number): void {
    this.roots.delete(pid)
    this.ownPids.delete(pid)
    this.rememberDropped(pid)
    this.scheduleFlush()
  }

  /** Snapshot of the currently recorded roots. */
  list(): OwnedRoot[] {
    return [...this.roots.values()]
  }

  /**
   * Remove this instance's own entries (used after a clean killAll). Roots a
   * sibling instance registered stay journaled: they are still live elsewhere,
   * and dropping them would leave that instance's processes unreapable if it
   * later dies without a clean shutdown.
   */
  clear(): void {
    for (const pid of this.ownPids) {
      this.roots.delete(pid)
      this.rememberDropped(pid)
    }
    this.ownPids.clear()
    this.scheduleFlush()
  }

  /**
   * Read the persisted roots, merging them with the in-memory set. Re-read on
   * every call so a long-lived instance still sees roots registered by a
   * sibling that started later (the journal is the cross-instance handoff).
   */
  async load(): Promise<OwnedRoot[]> {
    for (const root of await this.readStored()) {
      if (this.droppedPids.has(root.pid) || this.roots.has(root.pid)) continue
      this.roots.set(root.pid, root)
    }
    if (this.roots.size > MAX_ROOTS) this.pruneOldest()
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
    this.writeChain = this.writeChain.then(() => this.writeMerged())
    return this.writeChain
  }

  /**
   * Read-merge-write: keep every entry on disk we did not drop, overlay the
   * roots this instance registered (they hold the freshest command/cwd), then
   * replace the file. Entries only ever `load()`ed belong to another instance
   * and are never rewritten from memory   the file on disk is their truth, so a
   * sibling's own unregister can never be undone by our stale copy.
   */
  private async writeMerged(): Promise<void> {
    const stored = await this.readStored()
    const merged = new Map<number, OwnedRoot>()
    for (const root of stored) {
      if (this.droppedPids.has(root.pid)) continue
      merged.set(root.pid, root)
    }
    for (const root of this.roots.values()) {
      if (!this.ownPids.has(root.pid) || this.droppedPids.has(root.pid)) continue
      merged.set(root.pid, root)
    }
    const roots = [...merged.values()]
      .sort((left, right) => left.pid - right.pid)
      .slice(-MAX_ROOTS)
    const payload: OwnedRootStore = { version: STORE_VERSION, roots }
    await atomicWrite(this.filePath, payload)
    this.forgetPersistedDrops(stored)
  }

  /**
   * A drop only has to outlive the write that removes the entry. Once the pid is
   * gone from disk, a later re-appearance is a newer registration (the OS
   * recycled the pid for a live root), so the drop must stop erasing it.
   */
  private forgetPersistedDrops(stored: readonly OwnedRoot[]): void {
    if (this.droppedPids.size === 0) return
    const onDisk = new Set(stored.map((root) => root.pid))
    for (const pid of [...this.droppedPids]) {
      if (!onDisk.has(pid)) this.droppedPids.delete(pid)
    }
  }

  private pruneOldest(): void {
    const sorted = [...this.roots.values()].sort((a, b) => a.pid - b.pid)
    for (const root of sorted.slice(0, this.roots.size - MAX_ROOTS)) {
      this.roots.delete(root.pid)
      this.ownPids.delete(root.pid)
    }
  }

  /**
   * Remember a pid this instance dropped so a later merge cannot restore it.
   * Bounded like the root set: Set keeps insertion order, so the oldest drop is
   * forgotten first (a pid recycled that late is no longer our concern).
   */
  private rememberDropped(pid: number): void {
    this.droppedPids.delete(pid)
    this.droppedPids.add(pid)
    while (this.droppedPids.size > MAX_ROOTS) {
      const oldest = this.droppedPids.values().next()
      if (oldest.done) break
      this.droppedPids.delete(oldest.value)
    }
  }

  /** Entries currently persisted by any instance, newest file content wins. */
  private async readStored(): Promise<OwnedRoot[]> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      return parseStore(raw)
    } catch {
      // Missing or malformed journal is not an error   there is simply nothing to reap.
      return []
    }
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
