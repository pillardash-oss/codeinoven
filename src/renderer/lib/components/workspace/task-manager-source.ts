import { invoke } from '$lib/ipc.svelte'
import type { TaskManagerSnapshot } from '$shared/types'

/**
 * Where a task manager reads its processes and sends its actions.
 *
 * The desktop's own task manager and an Oven's are the same surface over two
 * machines, so the modal takes one of these instead of calling IPC directly.
 */
export interface TaskManagerSource {
  list(): Promise<TaskManagerSnapshot>
  killProcess(pid: number, force: boolean): Promise<void>
  stopService(id: string): Promise<void>
}

/** This machine: everything the app itself runs. */
export const localTaskManagerSource: TaskManagerSource = {
  list: () => invoke('taskManager:list'),
  killProcess: (pid, force) => invoke('taskManager:killProcess', pid, force),
  stopService: (id) => invoke('taskManager:stopService', id)
}

/** One Oven: the processes its service runs, and its live runs as services. */
export function ovenTaskManagerSource(ovenId: string): TaskManagerSource {
  return {
    list: () => invoke('oven:taskManagerList', ovenId),
    killProcess: (pid, force) => invoke('oven:taskManagerKillProcess', ovenId, pid, force),
    stopService: (id) => invoke('oven:taskManagerStopService', ovenId, id)
  }
}
