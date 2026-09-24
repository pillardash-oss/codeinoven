import type { AgentModelSelection } from './types/common'
import type { DesignAssignment, DesignConfig } from './types/settings'

/**
 * Design assignments, as pure functions.
 *
 * A design assignment is one named piece of design work and the model the user
 * assigned to it: image generation, SEO copy, long-form content, video, voice.
 * The model is never chosen by the app or by an agent working in a design
 * session; the user names it in Settings, Design, and the app runs exactly that
 * one model on exactly that work.
 *
 * Everything except the one-shot model call lives here, so the playbook the
 * agent reads, the `delegate` operation's refusal messages and the settings UI
 * all agree on what a usable assignment is and on which name resolves to which
 * assignment.
 */

/** Ceiling on assignments, so a hand-edited config cannot inflate the playbook. */
export const MAX_DESIGN_ASSIGNMENTS = 12

/** Longest accepted assignment id, the handle an agent names in a tool call. */
export const DESIGN_ASSIGNMENT_ID_MAX_LENGTH = 48

/** Longest accepted human label. */
export const DESIGN_ASSIGNMENT_LABEL_MAX_LENGTH = 60

/** Longest accepted standing instruction handed to the assigned model. */
export const DESIGN_ASSIGNMENT_INSTRUCTIONS_MAX_LENGTH = 2_000

const ASSIGNMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/u

/**
 * Turn a label into the stable id an agent types in a tool call.
 *
 * The id is what survives a label edit, so it is derived once at creation and
 * kept: `SEO copy` becomes `seo-copy`, and an empty or all-symbol label becomes
 * `assignment`.
 */
export function designAssignmentIdFromLabel(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, DESIGN_ASSIGNMENT_ID_MAX_LENGTH)
    .replace(/-+$/u, '')
  return slug.length > 0 && ASSIGNMENT_ID_PATTERN.test(slug) ? slug : 'assignment'
}

/** Whether a string is a usable assignment id. */
export function isDesignAssignmentId(value: string): boolean {
  return ASSIGNMENT_ID_PATTERN.test(value)
}

/**
 * Whether an assignment may be executed.
 *
 * A selection missing any of harness, provider or model is treated as
 * unassigned rather than sent somewhere plausible, so a partially written
 * config can never route work to a model the user did not name.
 */
export function isUsableDesignSelection(
  selection: AgentModelSelection | undefined | null
): selection is AgentModelSelection {
  return Boolean(selection?.harnessId && selection.providerId && selection.modelId)
}

/** Whether one assignment carries everything needed to run it. */
export function isUsableDesignAssignment(
  assignment: DesignAssignment | undefined | null
): assignment is DesignAssignment {
  return Boolean(
    assignment &&
    isDesignAssignmentId(assignment.id) &&
    isUsableDesignSelection(assignment.selection)
  )
}

/** Every assignment the config holds, in the order the user listed them. */
export function designAssignmentsFromConfig(
  config: DesignConfig | undefined | null
): DesignAssignment[] {
  return Array.isArray(config?.assignments) ? config.assignments : []
}

/** Only the assignments that can actually run. */
export function usableDesignAssignments(
  config: DesignConfig | undefined | null
): DesignAssignment[] {
  return designAssignmentsFromConfig(config).filter(isUsableDesignAssignment)
}

/**
 * The assignment a name refers to.
 *
 * An agent may name either the id (`seo-copy`) or the label (`SEO copy`), and
 * both are matched case-insensitively, because the assignment is written by a
 * human and read by a model. The label's slug is accepted too, so the two
 * spellings an agent is most likely to invent both land on the same row.
 */
export function resolveDesignAssignment(
  config: DesignConfig | undefined | null,
  name: string
): DesignAssignment | null {
  const wanted = name.trim().toLowerCase()
  if (wanted.length === 0) return null
  for (const assignment of usableDesignAssignments(config)) {
    if (assignment.id === wanted) return assignment
    if (assignment.label.trim().toLowerCase() === wanted) return assignment
    if (designAssignmentIdFromLabel(assignment.label) === wanted) return assignment
  }
  return null
}

/** One assignment as an agent or a reader names it: `SEO copy (seo-copy)`. */
export function designAssignmentReference(assignment: DesignAssignment): string {
  return `${assignment.label.trim()} (${assignment.id})`
}

/**
 * A free handle for a new assignment labelled `label`.
 *
 * The id is what the agent types, so two rows may never share one: a second
 * `SEO copy` becomes `seo-copy-2` rather than making the name ambiguous.
 */
export function uniqueDesignAssignmentId(
  config: DesignConfig | undefined | null,
  label: string
): string {
  const taken = new Set(designAssignmentsFromConfig(config).map((assignment) => assignment.id))
  const base = designAssignmentIdFromLabel(label)
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix <= MAX_DESIGN_ASSIGNMENTS + taken.size; suffix += 1) {
    const candidate = `${base.slice(0, DESIGN_ASSIGNMENT_ID_MAX_LENGTH - 4)}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base.slice(0, DESIGN_ASSIGNMENT_ID_MAX_LENGTH - 8)}-${taken.size + 2}`
}

/** Every usable assignment, for a message that has to list them. */
export function designAssignmentCatalogue(config: DesignConfig | undefined | null): string {
  return usableDesignAssignments(config).map(designAssignmentReference).join(', ')
}
