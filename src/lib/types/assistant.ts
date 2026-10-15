import type { AgentModelSelection } from './common'
import type { AssistantSchedule } from './schedule'

/**
 * A channel an assistant can deliver its output to. `in-app` is a normal thread
 * notification inside CodeInOven and is the only channel wired up today; every
 * other channel needs a connection the assistant must have first.
 */
export type AssistantDeliveryChannel =
  'in-app' | 'telegram' | 'whatsapp' | 'signal' | 'slack' | 'email' | 'other'

/**
 * Where an assistant's runs execute. An absent target means this computer. A
 * target names an Oven the runs are dispatched to, so scheduled assistant work
 * can run off the user's device, plus the workspace root it uses there.
 */
export interface AssistantExecution {
  /** Oven id, or the local sentinel. Absence of the whole object means local. */
  ovenId: string
  /** Absolute workspace on the selected Oven, independent of the local project path. */
  ovenPath?: string
}

/** Where an assistant's output goes, and to which concrete destination. */
export interface AssistantDelivery {
  /** The channel the user agreed on. */
  channel: AssistantDeliveryChannel
  /**
   * The concrete destination the user named: a chat, a channel, an address.
   * Absent for `in-app`, which has no destination to name.
   */
  target?: string
  /** The agent's own note on how delivery works for this assistant. */
  note?: string
}

/** Time-based priority bracket: how soon the output matters. */
export type AssistantTimeliness = 'now' | 'today' | 'tomorrow' | 'this-week' | 'whenever'

/** Scope-based priority bracket: how far the output's impact reaches. */
export type AssistantImpact = 'just-me' | 'team' | 'company' | 'critical'

/**
 * An assistant's urgency on two independent brackets. `timeliness` is time-based
 * (how soon it matters) and `impact` is scope-based (how far it reaches), so
 * "urgent" is never a single answer.
 */
export interface AssistantPriority {
  timeliness: AssistantTimeliness
  impact: AssistantImpact
}

/**
 * An Assistant is the top-level assistant grouping ("Triage CodeInOven PRs daily,
 * 9am and 5pm"). It owns the agent-authored knowledge that every task inside it
 * reuses, a default schedule that tasks may override, and the set of
 * connections (skills, MCPs, plugins) picked from the app-level utility
 * library. Hierarchy is always Assistant -> Task -> one continuous thread per
 * task, and a task may exist without an assistant.
 */
export interface Assistant {
  id: string
  name: string
  /**
   * The assistant's own description, written by the user for their own reference
   * (what the assistant is for). It is never sent to the agent and never becomes
   * part of the knowledge.
   */
  description?: string
  /**
   * How the assistant should behave and speak, written by its owner when they
   * create it ("You manage my X and LinkedIn accounts, and you write in my
   * voice"). It rides every turn of the assistant's threads, ahead of the
   * knowledge, so the assistant answers as the person they were given.
   */
  personality?: string
  /**
   * Whether this assistant runs on a schedule. On by default, so an assistant the
   * user has always known about keeps firing. When off, the assistant is
   * on-demand only: it has no schedule, its tasks never fire on a clock, and
   * the authoring agent never asks the user for a schedule. Absent means on, so
   * rows written before this flag existed still read as scheduled.
   */
  scheduled?: boolean
  /**
   * What its owner calls the assistant's clock ("Daily social check"), so a
   * schedule reads as a named habit rather than a bare cadence. Only meaningful
   * while the assistant runs on a schedule; absent falls back to the assistant's
   * own name.
   */
  scheduleName?: string
  /** Accent colour from the project palette; rendered as the row's left border. */
  color?: string
  /** Filename of the assistant's stored icon image, relative to its storage dir. */
  icon?: string
  /** Key of the selected SVG icon type (mirrors Project.iconType). */
  iconType?: string
  /** Sanitized custom SVG pasted by the user. Dynamic non-neutral colours use currentColor. */
  customSvg?: string
  /** Default schedule for the assistant's tasks; a task may override it. */
  schedule?: AssistantSchedule | null
  /**
   * When the schedule last became active (epoch ms). A schedule slot that came
   * due before this moment was never really due: the assistant (or its schedule)
   * did not exist yet, so the scheduler must not fire it or record it as
   * missed. Stamped when the schedule changes and when an assistant first becomes
   * runnable (its knowledge is written), since the authoring flow saves both
   * together.
   */
  scheduleUpdatedAt?: number
  /**
   * Agent-authored knowledge   the assistant's prompt context. The UI never calls
   * this a "system prompt". An empty knowledge marks the assistant Incomplete.
   */
  knowledge: string
  /** When the knowledge was last written by the agent or edited by the user. */
  knowledgeUpdatedAt?: number
  /** Connections picked from the app-level utility library. */
  connections: AssistantConnection[]
  /**
   * Where the assistant's output is delivered. Absent for an assistant that reports
   * nothing to the user (an action-only assistant).
   */
  delivery?: AssistantDelivery
  /**
   * The assistant's agreed default urgency. Each run may refine it, since the
   * agent often only learns the real bracket from what it found.
   */
  priority?: AssistantPriority
  /**
   * The models this assistant runs on: one primary and zero or more fallbacks,
   * each with its own thinking level and account. An assistant is Incomplete
   * until a primary is picked.
   */
  agents?: AssistantAgents
  /**
   * Where this assistant's runs execute. Absent means this computer. A task may
   * override it with an Oven of its own; otherwise every dispatched run uses
   * this target, so an assistant can be kept off the user's device.
   */
  execution?: AssistantExecution
  /**
   * A paused assistant keeps its tasks and knowledge but the scheduler never fires
   * it. Resumed from the assistant panel's All tab.
   */
  paused?: boolean
  /** Pinned assistants sort above the rest and render a pin indicator. */
  pinned?: boolean
  /** When the assistant was pinned; newest pins sort first. */
  pinnedAt?: number
  /**
   * A manual sidebar position, written when the user drags the assistant. A
   * assistant without one keeps its creation order (newest first), and an edit
   * never moves an assistant, so the list only changes when the user changes it.
   */
  sortOrder?: number
  createdAt: number
  updatedAt: number
}

/** One utility the assistant enables for its tasks. Tasks may add or replace. */
export interface AssistantConnection {
  /** Utility id from the app-level library (e.g. `cio:browser`). */
  utilityId: string
  /** Display label snapshot so the panel renders without resolving the library. */
  label: string
  /** Utility kind snapshot (mcp, skill, plugin, web_search…). */
  kind?: string
  /**
   * Named by the authoring agent as a capability the assistant needs, before the
   * matching utility exists in the library. A required connection that does not
   * resolve is surfaced as needing setup rather than as a working connection.
   */
  required?: boolean
  /**
   * The setup prompt the authoring agent recorded when it could not supply this
   * connection itself: what the capability is, where it comes from, and how to
   * wire it up. It becomes the request an assisted setup thread opens with, so
   * the user only has to read it and press send.
   */
  setup?: string
}

/**
 * The model set an assistant runs on: one primary and any number of fallbacks the
 * runner falls back to when the primary fails. The primary is the model the
 * user was already working on when they created the assistant; fallbacks are
 * added later from the panel's Agents tab (the agent points the user at it).
 */
export interface AssistantAgents {
  primary?: AgentModelSelection
  fallbacks: AgentModelSelection[]
}

/** Fallbacks the assistant panel asks for when an assistant is first created. */
export const ASSISTANT_DEFAULT_FALLBACKS = 2

/**
 * Fixed title of an assistant's seed task   the "Getting started" conversation
 * where the knowledge is authored. It is never auto-titled.
 */
export const ASSISTANT_SETUP_TITLE = 'Getting started'

/**
 * The name an assistant wears until its owner gives it one.
 *
 * The create flow needs something to store the moment an assistant exists, and
 * the chat-creation flow deliberately creates an assistant with nothing known
 * about it, so the first thing its conversation does is ask what to call it. Any
 * surface that would otherwise present this as a chosen name checks it against
 * this constant.
 */
export const ASSISTANT_PLACEHOLDER_NAME = 'New assistant'

/** Whether an assistant is still wearing the name it was created with. */
export function assistantIsUnnamed(assistant: Pick<Assistant, 'name'>): boolean {
  return assistant.name.trim() === ASSISTANT_PLACEHOLDER_NAME
}

export interface CreateAssistantInput {
  name: string
  description?: string
  /** How the assistant should behave and speak; rides every turn of its threads. */
  personality?: string
  /** Defaults to true: an assistant runs on a schedule unless the user turns it off. */
  scheduled?: boolean
  /** What the owner calls the assistant's clock; only used while it is scheduled. */
  scheduleName?: string
  color?: string
  iconType?: string
  schedule?: AssistantSchedule | null
  knowledge?: string
  connections?: AssistantConnection[]
  delivery?: AssistantDelivery
  priority?: AssistantPriority
  agents?: AssistantAgents
  execution?: AssistantExecution
  paused?: boolean
}

export interface UpdateAssistantInput {
  name?: string
  /** `null` clears the description. */
  description?: string | null
  /** `null` clears the personality, leaving the assistant with no voice of its own. */
  personality?: string | null
  /** Turn the assistant's schedule on or off; turning it off clears its schedule. */
  scheduled?: boolean
  /** `null` clears the schedule's name, falling back to the assistant's own name. */
  scheduleName?: string | null
  /** `null` clears the accent colour, restoring the neutral border. */
  color?: string | null
  icon?: string | null
  /** `null` clears the SVG icon type. */
  iconType?: string | null
  /** `null` clears the custom SVG icon. */
  customSvg?: string | null
  schedule?: AssistantSchedule | null
  knowledge?: string
  connections?: AssistantConnection[]
  /** `null` clears the delivery, for an assistant that reports nothing. */
  delivery?: AssistantDelivery | null
  /** `null` clears the priority default, leaving it to each run. */
  priority?: AssistantPriority | null
  agents?: AssistantAgents
  /** `null` clears the target, moving the assistant's runs back to this computer. */
  execution?: AssistantExecution | null
  paused?: boolean
}

/**
 * Whether an assistant runs on a schedule. Absent means scheduled, so every assistant
 * written before the flag existed keeps firing, and the flag is the single rule
 * every surface reads instead of re-deriving `scheduled !== false`.
 */
export function assistantIsScheduled(assistant: Pick<Assistant, 'scheduled'>): boolean {
  return assistant.scheduled !== false
}

/** An assistant is complete only once its knowledge exists; drives the amber badge. */
export function assistantKnowledgeComplete(assistant: Pick<Assistant, 'knowledge'>): boolean {
  return assistant.knowledge.trim().length > 0
}

/**
 * Whether a save is the one that gives an assistant its first knowledge: the moment
 * it stops being a draft and its owner has work they expect to run. Compares
 * the assistant before and after the save, so every caller reads one rule instead
 * of re-deriving it from the incoming patch.
 */
export function assistantFirstKnowledgeSave(
  before: Pick<Assistant, 'knowledge'>,
  after: Pick<Assistant, 'knowledge'>
): boolean {
  return !assistantKnowledgeComplete(before) && assistantKnowledgeComplete(after)
}

/**
 * Whether the assistant has its model set. An assistant without a primary model
 * cannot run a task, so the panel marks it Incomplete.
 */
export function assistantAgentsComplete(assistant: Pick<Assistant, 'agents'>): boolean {
  return Boolean(assistant.agents?.primary?.modelId)
}

/** An assistant is ready to run once both its knowledge and its model set exist. */
export function assistantReady(assistant: Pick<Assistant, 'knowledge' | 'agents'>): boolean {
  return assistantKnowledgeComplete(assistant) && assistantAgentsComplete(assistant)
}

/**
 * What removing one assistant swept, so the caller can clear the scheduler's
 * records for it and tell the user what went with the assistant.
 */
export interface AssistantDeletionResult {
  /**
   * Every thread removed with the assistant: its tasks, its hidden knowledge thread,
   * and the runs swept with the task they ran. The scheduler matches its missed
   * records against these ids, so a pending miss of a removed task stops
   * badging at once instead of surviving until the next launch.
   */
  removedThreadIds: string[]
  /**
   * Task threads removed. The hidden knowledge thread is not a task and is not
   * counted here, so the number matches what the user saw in the sidebar.
   */
  taskCount: number
  /** Run threads swept with the task they ran. */
  runCount: number
  /**
   * Whether the assistant's artifact folder was deleted from disk. False only
   * when a removal genuinely failed, since an already-missing folder counts as
   * removed.
   */
  artifactsRemoved: boolean
}
