/**
 * Idle windows for the embedded terminal that runs a harness install, update or
 * removal.
 *
 * A single-command session is stopped once it has been *completely silent* for
 * its window (see `sweepIdleSessions` in `src/main/system/pty-service.ts`), so
 * the window has to outlast the longest silence a healthy run produces, not the
 * run's total duration. Most updaters print progress continuously and fit in a
 * minute. Antigravity's own updater prints one line per phase and then pulls its
 * whole release, 84-100 MiB depending on the platform, without emitting a single
 * byte: the one-minute window killed a healthy download 60s in and left the
 * install exactly where it started.
 *
 * A silent download's length scales with the connection, so its window has to be
 * generous. Ten minutes still bounds a genuinely stuck updater, while tolerating
 * the download down to roughly 150 KiB/s.
 */
export const HARNESS_RUN_IDLE_UPDATE_MS = 60_000
export const HARNESS_RUN_IDLE_INSTALL_MS = 300_000
export const HARNESS_RUN_IDLE_SILENT_DOWNLOAD_MS = 600_000

/**
 * Harnesses whose updater goes quiet for a whole release download. Keep this
 * list short and evidence-backed: every entry here trades hang detection speed
 * for tolerance of a silent download.
 */
const SILENT_DOWNLOAD_UPDATERS: ReadonlySet<string> = new Set<string>(['antigravity'])

export type HarnessRunTask = 'install' | 'update' | 'uninstall'

/**
 * The idle window for a run, or `undefined` when the run should not be watched
 * (a removal never downloads and finishes quickly, so it keeps no watchdog).
 */
export function harnessRunIdleTimeoutMs(
  task: HarnessRunTask,
  harnessId: string
): number | undefined {
  if (task === 'uninstall') return undefined
  if (task === 'install') return HARNESS_RUN_IDLE_INSTALL_MS
  return SILENT_DOWNLOAD_UPDATERS.has(harnessId)
    ? HARNESS_RUN_IDLE_SILENT_DOWNLOAD_MS
    : HARNESS_RUN_IDLE_UPDATE_MS
}
