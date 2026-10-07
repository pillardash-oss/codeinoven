import type { BrowserBoxMenuEntry } from './browser-box-menu'

export interface BrowserTabContextMenuGroup {
  id: string
  name: string
}

export interface BrowserTabContextMenuInput {
  threadScoped?: boolean
  tabId: string
  title: string
  url: string
  bookmarkAvailable: boolean
  bookmarked: boolean
  pinned: boolean
  groupId: string | null
  boxId: string | null
  canReopenClosedTab: boolean
  groups: BrowserTabContextMenuGroup[]
  boxes: BrowserBoxMenuEntry[]
}

export type BrowserTabContextMenuChoice =
  | { action: 'edit' }
  | { action: 'togglePin' }
  | { action: 'toggleBookmark' }
  | { action: 'duplicate' }
  | { action: 'newBefore' }
  | { action: 'newTab' }
  | { action: 'newPlaced'; groupId: string | null; boxId: string | null }
  | { action: 'createGroup' }
  | { action: 'editGroup' }
  | { action: 'removeFromGroup' }
  | { action: 'moveToGroup'; groupId: string }
  | { action: 'reopenInBox'; boxId: string | null }
  | { action: 'reopenClosed' }
  | { action: 'close' }
