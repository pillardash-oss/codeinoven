import type { RoutineSchedule } from './schedule'

/**
 * A Routine is the top-level assistant grouping ("Triage CodeInOven PRs daily,
 * 9am and 5pm"). It owns the agent-authored how-to that every task inside it
 * reuses, a default schedule that tasks may override, and the set of
 * connections (skills, MCPs, plugins) picked from the app-level utility
 * library. Hierarchy is always Routine -> Task -> one continuous thread per
 * task, and a task may exist without a routine.
 */
export interface Routine {
  id: string
  name: string
  /** Accent colour from the project palette; rendered as the row's left border. */
  color?: string
  /** Filename of the routine's stored icon image, relative to its storage dir. */
  icon?: string
  /** Key of the selected SVG icon type (mirrors Project.iconType). */
  iconType?: string
  /** Default schedule for the routine's tasks; a task may override it. */
  schedule?: RoutineSchedule | null
  /**
   * Agent-authored how-to   the routine's prompt context. The UI never calls
   * this a "system prompt". An empty how-to marks the routine Incomplete.
   */
  howTo: string
  /** When the how-to was last written by the agent or edited by the user. */
  howToUpdatedAt?: number
  /** Connections picked from the app-level utility library. */
  connections: RoutineConnection[]
  /** Position for manual ordering; items without sortOrder fall back to updatedAt. */
  sortOrder?: number
  createdAt: number
  updatedAt: number
}

/** One utility the routine enables for its tasks. Tasks may add or replace. */
export interface RoutineConnection {
  /** Utility id from the app-level library (e.g. `cio:browser`). */
  utilityId: string
  /** Display label snapshot so the panel renders without resolving the library. */
  label: string
  /** Utility kind snapshot (mcp, skill, plugin, web_search…). */
  kind?: string
}

export interface CreateRoutineInput {
  name: string
  color?: string
  iconType?: string
  schedule?: RoutineSchedule | null
  howTo?: string
  connections?: RoutineConnection[]
}

export interface UpdateRoutineInput {
  name?: string
  color?: string
  icon?: string | null
  iconType?: string
  schedule?: RoutineSchedule | null
  howTo?: string
  connections?: RoutineConnection[]
}

/** A routine is complete only once its how-to exists; drives the amber badge. */
export function routineHowToComplete(routine: Pick<Routine, 'howTo'>): boolean {
  return routine.howTo.trim().length > 0
}
