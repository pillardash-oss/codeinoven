import { trustedIpcMain as ipcMain } from './trusted-ipc-main'
import type { PerfRecord } from '../../lib/perf-trace'
import { sanitizePerfBatch } from '../../lib/perf-trace'
import { PERF_RECORDS_SEND_CHANNEL } from '../../lib/ipc/perf-trace'
import { perfTrace } from '../system/perf-trace'
import { readAppMemory, sampleAppMemory } from '../system/perf-memory-sampler'

/** How long a renderer's working set is reused before it is read again. */
const WORKING_SET_CACHE_MS = 2_000

let cachedWorkingSets: { readAt: number; byPid: Map<number, number> } | null = null

/**
 * The working set of the renderer that sent a record.
 *
 * A renderer cannot read its own OS working set, and asking the OS once per
 * record would measure the trace instead of the app, so the rows are read once
 * and reused for a couple of seconds. That is far finer than any memory curve
 * worth drawing: a renderer does not change its footprint by a megabyte in two
 * seconds.
 */
function workingSetFor(pid: number): number | undefined {
  const now = Date.now()
  if (!cachedWorkingSets || now - cachedWorkingSets.readAt > WORKING_SET_CACHE_MS) {
    const byPid = new Map<number, number>()
    for (const process of readAppMemory().processes) {
      if (process.memoryBytes !== null) byPid.set(process.pid, process.memoryBytes)
    }
    cachedWorkingSets = { readAt: now, byPid }
  }
  return cachedWorkingSets.byPid.get(pid)
}

/**
 * The performance-trace IPC surface.
 *
 * Registered with the other pre-navigation handlers: the renderer starts
 * measuring at its first statement, and a record that arrives before the channel
 * exists is simply lost, which would leave exactly the startup window — the one
 * nobody can see any other way — unmeasured.
 */
export function registerPerfTraceIpcHandlers(): void {
  ipcMain.handle('perf:memory', () => {
    const sample = readAppMemory()
    return {
      totalBytes: sample.totalBytes,
      deviceBytes: sample.deviceBytes,
      processes: sample.processes
    }
  })

  ipcMain.handle('perf:flush', async () => {
    await perfTrace.flush()
  })

  ipcMain.on(PERF_RECORDS_SEND_CHANNEL, (event, raw: unknown) => {
    const records = sanitizePerfBatch(raw)
    if (records.length === 0) return
    let senderPid = 0
    try {
      senderPid = event.sender.getOSProcessId()
    } catch {
      // A window that closed while its records were in flight: the records are
      // still worth writing, they just cannot be attributed to a process.
    }
    const workingSet = senderPid > 0 ? workingSetFor(senderPid) : undefined
    for (const record of records) perfTrace.record(withWorkingSet(record, workingSet))
  })
}

/**
 * Stamp a renderer record with the cost of the process that produced it.
 *
 * The value the renderer sends wins when it has one (a main-process record read
 * its own runtime), and the OS reading fills the gap for renderers.
 */
function withWorkingSet(record: PerfRecord, workingSet: number | undefined): PerfRecord {
  if (workingSet === undefined || record.processMemoryBytes !== undefined) return record
  return { ...record, processMemoryBytes: workingSet }
}

/** Take a memory sample now, from a main-process caller that wants one on demand. */
export { sampleAppMemory }
