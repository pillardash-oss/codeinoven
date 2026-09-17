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
 *  palette. */
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
  }
]

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

/** The permission level an action selects, when the action is a permission toggle. */
export function permissionLevelForAction(action: ActionDefinition): PermissionLevel | undefined {
  return PERMISSION_LEVELS.find((level) => permissionLevelActionId(level.id) === action.id)?.id
}

/** The permission levels as selectable actions for the given source. */
export function permissionLevelActions(source: ActionSource): ActionDefinition[] {
  return PERMISSION_LEVELS.map((level) => ({
    id: permissionLevelActionId(level.id),
    title: `Permissions: ${level.label}`,
    description: level.description,
    category: 'mode',
    source,
    keywords: [...level.keywords, level.label]
  }))
}
