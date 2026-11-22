import { randomUUID } from 'node:crypto'

/**
 * Who a process on this machine belongs to.
 *
 * Several CodeInOven instances run side by side (the installed app, `bun dev`,
 * probes), and every one of them sees the same process table. So the marker names
 * the instance, not the app: an instance adopts and stops what carries its own
 * stamp, and nothing else. This module imports nothing of the app's, so the entry
 * can use it before anything is spawned.
 */

/** Marker env var set on every process spawned for a harness, holding the id of the
 * instance that spawned it. Inherited by agent-spawned children, so it also never
 * matches a user's own external claude-code/opencode sessions. */
export const OWNED_PROCESS_MARKER = 'CODEINOVEN_OWNED'

/** Companion marker stamped with the CodeInOven session id that spawned the
 * harness. Inherited by agent-spawned children   including daemons that
 * re-parent to launchd/init (e.g. the adb server)   so the agent process
 * service can attribute an orphaned daemon back to its owning thread even
 * after the parent harness process is gone. */
export const OWNED_SESSION_MARKER = 'CODEINOVEN_SESSION'

/**
 * This instance's stamp: its pid, so others can tell whether it is still running,
 * and a nonce, so a recycled pid is never mistaken for it. It never starts with `1`,
 * the whole value older versions wrote and still match on as a prefix.
 */
export const INSTANCE_OWNER_ID = `i-${process.pid}-${randomUUID().slice(0, 8)}`

const OWNER_ID = /^i-(\d+)-[\da-f]{8}$/u

export function isOwnerId(value: unknown): value is string {
  return typeof value === 'string' && OWNER_ID.test(value)
}

/** Whether the instance that wrote a stamp is still running. */
export function isOwnerRunning(owner: string, alive: ReadonlySet<number>): boolean {
  if (owner === INSTANCE_OWNER_ID) return true
  const pid = Number(OWNER_ID.exec(owner)?.[1])
  // An earlier run that had this process's pid is, by definition, gone.
  return pid !== process.pid && alive.has(pid)
}

/**
 * Forget the stamp this process inherited from whatever launched it.
 *
 * An instance started from another's agent shell (`bun run dev:probe`) inherits
 * that instance's stamp, and every child spawned with a plain environment would
 * pass it on and be adopted, then stopped, by the other instance.
 */
export function dropInheritedOwnership(environment: NodeJS.ProcessEnv = process.env): void {
  delete environment[OWNED_PROCESS_MARKER]
  delete environment[OWNED_SESSION_MARKER]
}

/** The adb server and the Android emulator, matched on the executable being run. */
const SHARED_DAEMONS: readonly RegExp[] = [
  /^"?(?:\S*[\\/])?adb(?:\.exe)?"?\s(?:.*\s)?fork-server(?:\s|$)/u,
  /^"?(?:\S*[\\/])?qemu-system-[\w-]+(?:\.exe)?"?(?:\s|$)/u,
  /^"?(?:\S*[\\/])?emulator(?:\.exe)?"?\s(?:.*\s)?(?:-avd\s|@)/u
]

/**
 * A daemon the whole machine shares, whoever happened to start it first. Automatic
 * stops (quit, thread cleanup, orphan reaping) leave these running; only a person
 * ending that exact process stops one.
 */
export function isSharedDaemon(command: string): boolean {
  return SHARED_DAEMONS.some((pattern) => pattern.test(command))
}

/** Slack for `ps` rounding a process's age to whole seconds. */
const START_TOLERANCE_MS = 5_000

/**
 * Whether a pid now names a newer process than the one recorded at `recordedAt`.
 * A process cannot have started after it was first seen, so this one must not be
 * signalled on that record.
 */
export function isRecycledPid(startedAt: number | undefined, recordedAt: number): boolean {
  return startedAt !== undefined && startedAt > recordedAt + START_TOLERANCE_MS
}

/** When a process started, from `ps`'s `[[dd-]hh:]mm:ss` age. */
export function startedAtFromElapsed(elapsed: string, capturedAt: number): number | undefined {
  const match = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/u.exec(elapsed)
  if (!match) return undefined
  const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0))
  const age = (((days ?? 0) * 24 + (hours ?? 0)) * 60 + (minutes ?? 0)) * 60 + (seconds ?? 0)
  return capturedAt - age * 1_000
}
