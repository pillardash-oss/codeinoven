/**
 * The app's CIO Pi hosts, owned by main.
 *
 * The supervisor stays lazy: nothing starts until the first session asks for it,
 * and a host stops itself when the last session on it goes away. Every live host
 * is registered with the app's service registry while it runs, one row per
 * process, so the task manager lists a real process per host (pid, CPU and
 * memory) instead of a row per thread, and main can stop one of them.
 */
import { PiHostSupervisor } from './pi-host-supervisor'
import { spawnPiHost } from './pi-host-launcher'
import { appServiceRegistry } from '../system/app-service-registry'
import { Logger } from '../system/logger'

let supervisor: PiHostSupervisor | null = null
let unsubscribeHosts: (() => void) | null = null
/** Registry row per live host, keyed by its OS pid. */
const hostServiceIds = new Map<number, string>()

/** The supervisor every hosted session goes through. */
export function piHostSupervisor(): PiHostSupervisor {
  if (supervisor !== null) return supervisor
  const created = new PiHostSupervisor(spawnPiHost, { requestTimeoutMs: 10 * 60_000 })
  // A host is a process, so its row is created when it starts and dropped when
  // it goes: a service announced without a pid had no process behind it, which
  // is exactly why the task manager could show the host but never its usage.
  unsubscribeHosts = created.onHostsChanged(() => syncHostServices(created))
  syncHostServices(created)
  Logger.dev('CIO Pi host supervisor created')
  supervisor = created
  return created
}

/** Release the supervisor and its service rows. Sessions end; transcripts stay. */
export function stopPiHost(): void {
  unsubscribeHosts?.()
  unsubscribeHosts = null
  supervisor?.stop()
  supervisor = null
  for (const id of hostServiceIds.values()) appServiceRegistry.unregister(id)
  hostServiceIds.clear()
}

/**
 * Reconcile one registry row per live host.
 *
 * Rows are keyed by pid, so a host that exited loses its row and a new host
 * gets its own, and re-registering a live one keeps its original start time.
 */
function syncHostServices(host: PiHostSupervisor): void {
  const pids = host.pids()
  for (const [pid, id] of [...hostServiceIds]) {
    if (pids.includes(pid)) continue
    appServiceRegistry.unregister(id)
    hostServiceIds.delete(pid)
  }
  pids.forEach((pid, index) => {
    const detail =
      pids.length === 1
        ? 'Hosts every Pi thread on this device'
        : `Pi host ${index + 1} of ${pids.length} on this device`
    hostServiceIds.set(
      pid,
      appServiceRegistry.register({
        id: `pi-host-${pid}`,
        kind: 'worker',
        name: pids.length === 1 ? 'CIO Pi host' : `CIO Pi host ${index + 1}`,
        detail,
        scope: 'app',
        pid,
        // Ending one host takes only its own sessions, so the others keep
        // working; their clients are told the way a crash tells them.
        stop: () => host.stopHost(pid)
      })
    )
  })
}
