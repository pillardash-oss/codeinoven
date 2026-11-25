import type { OvenProcessSnapshot } from '../../lib/ovens'
import type { TaskManagerSnapshot } from '../../lib/types'

/** The prefix an Oven run carries as a task manager service id. */
const RUN_SERVICE_PREFIX = 'run:'

/**
 * Draw one Oven's process tree in the task manager's own shape.
 *
 * Every process is app-scoped: an Oven has no projects or threads of its own to
 * file one under. Each live run becomes a stoppable service, because stopping
 * the run through the service is cleaner than killing its process: the Oven
 * records it as stopped and its whole process group goes with it.
 */
export function ovenTaskManagerSnapshot(snapshot: OvenProcessSnapshot): TaskManagerSnapshot {
  const byPid = new Map(snapshot.processes.map((row) => [row.pid, row]))
  return {
    processes: snapshot.processes.map((row) => ({
      pid: row.pid,
      parentPid: row.parentPid,
      command: row.command,
      startedAt: row.startedAt,
      scope: 'app',
      cwd: row.cwd,
      projectId: null,
      threadId: null,
      ports: [],
      cpuPercent: row.cpuPercent,
      memoryBytes: row.memoryBytes
    })),
    services: snapshot.runs.map((run) => {
      const row = run.pid === null ? undefined : byPid.get(run.pid)
      return {
        id: `${RUN_SERVICE_PREFIX}${run.id}`,
        kind: 'worker',
        name: `${run.command} run`,
        detail: run.clientId ? `${run.cwd} (started by ${run.clientId})` : run.cwd,
        scope: 'app',
        projectId: null,
        threadId: null,
        pid: run.pid,
        port: null,
        url: null,
        startedAt: run.createdAt,
        stoppable: true,
        cpuPercent: row?.cpuPercent ?? null,
        memoryBytes: row?.memoryBytes ?? null
      }
    }),
    surfaces: [],
    power: { source: 'ac', thermalState: 'unknown' },
    sampledAt: Date.now()
  }
}

/** The run id a task manager service id names, or null for anything else. */
export function ovenRunIdOfService(serviceId: string): string | null {
  return serviceId.startsWith(RUN_SERVICE_PREFIX)
    ? serviceId.slice(RUN_SERVICE_PREFIX.length) || null
    : null
}
