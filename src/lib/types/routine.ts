import type { AgentModelSelection } from './common'
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
  /**
   * The models this routine runs on: one primary and zero or more fallbacks,
   * each with its own thinking level and account. A routine is Incomplete
   * until a primary is picked.
   */
  agents?: RoutineAgents
  /**
   * A paused routine keeps its tasks and how-to but the scheduler never fires
   * it. Resumed from the assistant panel's All tab.
   */
  paused?: boolean
  /** Pinned routines sort above the rest and render a pin indicator. */
  pinned?: boolean
  /** When the routine was pinned; newest pins sort first. */
  pinnedAt?: number
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
  /**
   * Named by the authoring agent as a capability the routine needs, before the
   * matching utility exists in the library. A required connection that does not
   * resolve is surfaced as needing setup rather than as a working connection.
   */
  required?: boolean
}

/**
 * The model set a routine runs on: one primary and any number of fallbacks the
 * runner falls back to when the primary fails. The assistant panel prompts for
 * one primary and two fallbacks on creation; more can be added there later.
 */
export interface RoutineAgents {
  primary?: AgentModelSelection
  fallbacks: AgentModelSelection[]
}

/** Fallbacks the assistant panel asks for when a routine is first created. */
export const ROUTINE_DEFAULT_FALLBACKS = 2

/**
 * Fixed title of a routine's seed task   the "Getting started" conversation
 * where the how-to is authored. It is never auto-titled.
 */
export const ASSISTANT_SETUP_TITLE = 'Getting started'

export interface CreateRoutineInput {
  name: string
  color?: string
  iconType?: string
  schedule?: RoutineSchedule | null
  howTo?: string
  connections?: RoutineConnection[]
  agents?: RoutineAgents
  paused?: boolean
}

export interface UpdateRoutineInput {
  name?: string
  /** `null` clears the accent colour, restoring the neutral border. */
  color?: string | null
  icon?: string | null
  /** `null` clears the SVG icon type. */
  iconType?: string | null
  schedule?: RoutineSchedule | null
  howTo?: string
  connections?: RoutineConnection[]
  agents?: RoutineAgents
  paused?: boolean
}

/** A routine is complete only once its how-to exists; drives the amber badge. */
export function routineHowToComplete(routine: Pick<Routine, 'howTo'>): boolean {
  return routine.howTo.trim().length > 0
}

/**
 * Whether the routine has its model set. A routine without a primary model
 * cannot run a task, so the panel marks it Incomplete.
 */
export function routineAgentsComplete(routine: Pick<Routine, 'agents'>): boolean {
  return Boolean(routine.agents?.primary?.modelId)
}

/** A routine is ready to run once both its how-to and its model set exist. */
export function routineReady(routine: Pick<Routine, 'howTo' | 'agents'>): boolean {
  return routineHowToComplete(routine) && routineAgentsComplete(routine)
}
