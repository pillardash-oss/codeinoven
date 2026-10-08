import type { BrowserBoxMenuEntry } from './browser-box-menu'

export interface BrowserTabSelectionMenuGroup {
  id: string
  name: string
}

export interface BrowserTabSelectionMenuInput {
  selectedCount: number
  groups: BrowserTabSelectionMenuGroup[]
  boxes: BrowserBoxMenuEntry[]
  canCreateGroup: boolean
}

export type BrowserTabSelectionMenuChoice =
  | { action: 'moveToGroup'; groupId: string }
  | { action: 'createGroup' }
  | { action: 'reopenInBox'; boxId: string | null }
