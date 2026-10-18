import type { AuthoredWorkKind } from '../ipc/design'
import { AUTHORED_WORK_KINDS } from './work-roots'

/**
 * The authored-work kinds a thread has entered, and how that set is stored.
 *
 * A thread row draws one marker per kind, but a thread is in one session at a
 * time, so this is deliberately a second fact beside `Thread.authoredWorkKind`
 * rather than a replacement for it. `authoredWorkKind` answers "which session is
 * this thread in now", which is what a preview resolves against, what the expert
 * card reads and what media generation writes into. This set answers "which
 * sessions has this thread entered", which is what the row's markers mean. A
 * thread that designed something and later cut a video about it has done both,
 * and the single session field can only ever name one of them.
 *
 * Stored as a JSON array (`["design","video"]`) so the set is readable in the
 * database without a second table. Every writer and every reader passes through
 * the helpers here, because two orderings of the same set would otherwise draw
 * the glyphs in two orders and rewrite each other's rows forever.
 */

/**
 * The set a stored column value holds: known kinds only, deduped, canonical.
 *
 * Tolerant on purpose. The value is JSON written by an older build, a newer
 * build or a hand-edited database, and a row that fails to parse must degrade to
 * "no recorded set" rather than fail a sidebar render.
 */
export function parseAuthoredWorkKinds(raw: string | null | undefined): AuthoredWorkKind[] {
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(parsed) ? orderAuthoredWorkKinds(parsed) : []
}

/** The set with one kind added. */
export function withAuthoredWorkKind(
  kinds: readonly AuthoredWorkKind[] | undefined,
  kind: AuthoredWorkKind
): AuthoredWorkKind[] {
  return orderAuthoredWorkKinds([...(kinds ?? []), kind])
}

/**
 * The column value for a set, or null when there is nothing to record.
 *
 * Null rather than `[]` so a thread that has never entered a session keeps an
 * empty column and the read path's `IS NOT ?` style guards keep working.
 */
export function serializeAuthoredWorkKinds(
  kinds: readonly AuthoredWorkKind[] | undefined
): string | null {
  const ordered = orderAuthoredWorkKinds(kinds ?? [])
  return ordered.length > 0 ? JSON.stringify(ordered) : null
}

/**
 * The known kinds of a value, deduped and in the app's canonical order.
 *
 * Canonical order is what makes the marker's glyphs stable: a thread that
 * designed first and a thread that filmed first draw their two glyphs in the
 * same sequence, and re-recording a kind already in the set never reshuffles it.
 */
export function orderAuthoredWorkKinds(values: readonly unknown[]): AuthoredWorkKind[] {
  const present = new Set<AuthoredWorkKind>()
  for (const value of values) {
    if (isAuthoredWorkKind(value)) present.add(value)
  }
  return AUTHORED_WORK_KINDS.filter((kind) => present.has(kind))
}

/** Whether a value from storage or an IPC payload is a kind this build knows. */
export function isAuthoredWorkKind(value: unknown): value is AuthoredWorkKind {
  return typeof value === 'string' && (AUTHORED_WORK_KINDS as readonly string[]).includes(value)
}
