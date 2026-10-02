/** Appearance shared by the sticky note tab and its edit dialog. */
export interface StickyNoteAppearance {
  title: string
  iconType: string | null
  customSvg: string | null
  color: string
}

/** Fields returned in the tab strip before the selected note body is loaded. */
export interface StickyNoteSummary extends StickyNoteAppearance {
  id: string
  createdAt: number
  updatedAt: number
}

/** A private note the user can open from any app view. */
export interface StickyNote extends StickyNoteSummary {
  body: string
}
