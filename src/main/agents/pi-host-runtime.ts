/**
 * The app's one CIO Pi host, owned by main.
 *
 * The supervisor stays lazy: nothing starts until the first session asks for it,
 * and the host stops itself when the last session on it goes away. The host is
 * registered with the app's service registry while it runs, so the task manager
 * lists one row for it instead of a row per thread, and main can stop it.
 */
import { PiHostSupervisor } from './pi-host-supervisor'
import { spawnPiHost } from './pi-host-launcher'
import { appServiceRegistry } from '../system/app-service-registry'
import { Logger } from '../system/logger'

let supervisor: PiHostSupervisor | null = null
let serviceId: string | null = null

/** The supervisor every hosted session goes through. */
export function piHostSupervisor(): PiHostSupervisor {
  if (supervisor !== null) return supervisor
  const created = new PiHostSupervisor(spawnPiHost, { requestTimeoutMs: 10 * 60_000 })
  serviceId = appServiceRegistry.register({
    kind: 'worker',
    name: 'CIO Pi host',
    detail: 'One host for every thread on this device',
    scope: 'app',
    pid: null,
    stop: () => {
      created.stop()
    }
  })
  Logger.dev('CIO Pi host supervisor created')
  supervisor = created
  return created
}

/** Release the supervisor and its service row. Sessions end; transcripts stay. */
export function stopPiHost(): void {
  supervisor?.stop()
  supervisor = null
  if (serviceId !== null) appServiceRegistry.unregister(serviceId)
  serviceId = null
}
