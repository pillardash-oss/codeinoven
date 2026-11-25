import { isOvenMode } from '$shared/permission-level'
import type { PermissionLevel } from '$shared/types'
import type { ActionDefinition, ActionId, ActionSource } from './types'

/** Every permission-level action carries this id prefix, whichever surface
 *  built it, so two owners can recognise each other's entries. */
const PERMISSION_ACTION_PREFIX = 'mode:permission:'

export interface PermissionLevelDescriptor {
  id: PermissionLevel
  label: string
  description: string
  keywords: readonly string[]
}

/** The permission levels a thread can run with, in the order every surface
 *  presents them: the composer's picker menu, the slash menu, and the action
 *  palette. `oven_mode` sits last because it is the highest level. */
export const PERMISSION_LEVELS: readonly PermissionLevelDescriptor[] = [
  {
    id: 'auto_review',
    label: 'Auto Review',
    description: 'Auto-run every permission unless it is explicitly denied',
    keywords: ['access', 'approval', 'security', 'review', 'deny']
  },
  {
    id: 'full_access',
    label: 'Full Access',
    description: 'Run in yolo mode: every operation auto-approved',
    keywords: ['access', 'approval', 'security', 'yolo', 'unrestricted']
  },
  {
    id: 'oven_mode',
    label: 'Oven Mode',
    description: 'Run unrestricted on this external Oven: no protective check applies there',
    keywords: ['access', 'approval', 'security', 'oven', 'remote', 'machine', 'unrestricted']
  }
]

/**
 * Who a permission surface is offering levels to.
 *
 * Oven Mode exists so the agent can do anything on an external Oven (a remote
 * machine) while it finishes a task there, so it is offered only while the
 * thread or composer targets one. Every other surface   a local thread, a chat,
 * an assistant task   must not show it at all, which is why the default is the
 * narrower list rather than the full catalog: a caller that forgets to say which
 * Oven it runs on gets the safe answer.
 */
export interface PermissionLevelOfferOptions {
  /** True when the thread or composer targets an external Oven (a remote machine). */
  oven?: boolean
}

/**
 * The permission levels a surface offers, in presentation order.
 *
 * `PERMISSION_LEVELS` stays the complete catalog so a level can always be
 * labelled and recognised; this is what a menu iterates.
 */
export function permissionLevelsFor(
  options: PermissionLevelOfferOptions = {}
): readonly PermissionLevelDescriptor[] {
  if (options.oven === true) return PERMISSION_LEVELS
  return PERMISSION_LEVELS.filter((entry) => !isOvenMode(entry.id))
}

/** Short label for a permission level, for surfaces that only need the name. */
export function permissionLevelLabel(level: PermissionLevel): string {
  return PERMISSION_LEVELS.find((entry) => entry.id === level)?.label ?? level
}

export function permissionLevelActionId(level: PermissionLevel): ActionId {
  return `${PERMISSION_ACTION_PREFIX}${level}`
}

/** True for a permission-level action, whichever surface built it. */
export function isPermissionLevelAction(action: ActionDefinition): boolean {
  return action.id.startsWith(PERMISSION_ACTION_PREFIX)
}

/** The permission level an action selects, when the action is a permission toggle.
 *
 *  Read against the whole catalog, not the offered subset: the gates that decide
 *  whether a level may be shown belong to the surface that builds the action, and
 *  a level that arrives here any other way still has to be recognised so the
 *  composer can apply its own fallback. */
export function permissionLevelForAction(action: ActionDefinition): PermissionLevel | undefined {
  return PERMISSION_LEVELS.find((level) => permissionLevelActionId(level.id) === action.id)?.id
}

/** The permission levels as selectable actions for the given source. */
export function permissionLevelActions(
  source: ActionSource,
  options: PermissionLevelOfferOptions = {}
): ActionDefinition[] {
  return permissionLevelsFor(options).map((level) => ({
    id: permissionLevelActionId(level.id),
    title: `Permissions: ${level.label}`,
    description: level.description,
    category: 'mode',
    source,
    keywords: [...level.keywords, level.label]
  }))
}
