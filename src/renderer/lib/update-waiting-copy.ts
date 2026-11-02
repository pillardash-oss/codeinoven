import type { UpdaterWaitingWork } from '$shared/ipc-contract'

/**
 * What a pending update install is still waiting on, phrased for a surface.
 *
 * The gate reports threads, downloads and dictation separately because they are
 * different waits: a thread finishes on its own, a download finishes on its own,
 * and a voice recording has to be transcribed and pasted before it is safe to
 * restart. Naming each is the only way the rail button and the Settings card can
 * say the same true thing the gate is acting on. Shared so they never drift.
 */
export function describeWaitingWork(work: UpdaterWaitingWork): string {
  const parts: string[] = []
  if (work.threads > 0) {
    parts.push(`${work.threads} active ${work.threads === 1 ? 'thread' : 'threads'}`)
  }
  if (work.downloads > 0) {
    parts.push(`${work.downloads} running ${work.downloads === 1 ? 'download' : 'downloads'}`)
  }
  if (work.speech > 0) {
    parts.push(`${work.speech} voice ${work.speech === 1 ? 'recording' : 'recordings'}`)
  }
  return parts.length === 0 ? 'active work' : parts.join(' and ')
}
