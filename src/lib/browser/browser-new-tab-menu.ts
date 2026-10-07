import type { BrowserBoxMenuEntry } from './browser-box-menu'

export interface BrowserNewTabMenuInput {
  groupId: string | null
  boxId: string | null
  anchored: boolean
  groups: Array<{ id: string; name: string }>
  boxes: BrowserBoxMenuEntry[]
}
export type BrowserNewTabMenuChoice =
  { action: 'new'; groupId: string | null; boxId: string | null } | { action: 'before' | 'after' }
