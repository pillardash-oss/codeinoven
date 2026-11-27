import type { TaskManagerProcess, TaskManagerService } from '$shared/types'

/** The rows a task manager draws, with one row per runtime. */
export interface CollapsedRuntimes {
  processes: TaskManagerProcess[]
  services: TaskManagerService[]
}

/**
 * Collapse a runtime the snapshot reported twice, once as a service and once as
 * its own process row.
 *
 * A service backed by a pid (the pooled Pi host, a thread's stdio MCP server) is
 * that pid: listing the tracked process of the same pid as well draws the same
 * memory and CPU under two owner nodes, and each node then counts it in its own
 * total. The stoppable service wins, because it carries the detail and the stop
 * action the process row does not. When the service cannot be stopped, the
 * process row wins instead, so the row that remains is the one that can be ended.
 *
 * A service with no pid of its own (an in-process loopback listener such as the
 * utility gateway) can never collide and is kept as it is.
 */
export function collapseDuplicateRuntimes(
  processes: readonly TaskManagerProcess[],
  services: readonly TaskManagerService[]
): CollapsedRuntimes {
  const stoppableServicePids = new Set(
    services.flatMap((service) => (service.stoppable && service.pid !== null ? [service.pid] : []))
  )
  const visibleProcesses = processes.filter((process) => !stoppableServicePids.has(process.pid))
  const visibleProcessPids = new Set(visibleProcesses.map((process) => process.pid))
  const drawnServicePids = new Set<number>()
  const visibleServices = services.filter((service) => {
    if (service.pid === null) return true
    // The process row is the endable one, so the unstoppable service steps aside.
    if (!service.stoppable && visibleProcessPids.has(service.pid)) return false
    // Another service already drew this runtime; a pid is one row.
    if (drawnServicePids.has(service.pid)) return false
    drawnServicePids.add(service.pid)
    return true
  })
  return { processes: visibleProcesses, services: visibleServices }
}
