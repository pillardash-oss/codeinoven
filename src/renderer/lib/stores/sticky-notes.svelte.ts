import { invoke } from '$lib/ipc.svelte'
import { PROJECT_COLORS } from '$lib/project-colors'
import type { StickyNoteAppearance, StickyNoteSummary } from '$shared/types'

export type StickyNoteSaveState = 'saved' | 'pending' | 'saving' | 'error'

export interface StickyNoteEntry extends StickyNoteSummary {
  body: string
  loaded: boolean
  loading: boolean
  saveState: StickyNoteSaveState
  saveError: string | null
}

interface NoteHistory {
  undo: string[]
  redo: string[]
  lastRecordedAt: number
}

const AUTOSAVE_DELAY_MS = 3000
const HISTORY_GROUP_DELAY_MS = 700
const MAX_HISTORY_ENTRIES = 100

function asEntry(summary: StickyNoteSummary): StickyNoteEntry {
  return {
    ...summary,
    body: '',
    loaded: false,
    loading: false,
    saveState: 'saved',
    saveError: null
  }
}

class StickyNotesState {
  private notes = $state<StickyNoteEntry[]>([])
  private activeId = $state<string | null>(null)
  private loaded = $state(false)
  private loading = $state(false)
  private loadError = $state<string | null>(null)
  private historyRevision = $state(0)
  private histories = new Map<string, NoteHistory>()
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private inFlightSaves = new Set<string>()
  private hydration: Promise<void> | null = null

  get entries(): StickyNoteEntry[] {
    return this.notes
  }

  get activeNote(): StickyNoteEntry | null {
    return this.notes.find((note) => note.id === this.activeId) ?? null
  }

  get activeNoteId(): string | null {
    return this.activeId
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  get isLoading(): boolean {
    return this.loading
  }

  get error(): string | null {
    return this.loadError
  }

  load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.hydration) return this.hydration
    this.loading = true
    this.loadError = null
    this.hydration = invoke('sticky-note:list')
      .then((summaries) => {
        this.notes = summaries.map(asEntry)
        this.activeId = this.notes[0]?.id ?? null
        this.loaded = true
        if (this.activeId) void this.loadBody(this.activeId)
      })
      .catch((error: unknown) => {
        this.loadError = error instanceof Error ? error.message : 'Could not load sticky notes'
        throw error
      })
      .finally(() => {
        this.loading = false
        this.hydration = null
      })
    return this.hydration
  }

  select(id: string): void {
    if (!this.notes.some((note) => note.id === id)) return
    this.activeId = id
    void this.loadBody(id)
  }

  async create(): Promise<StickyNoteEntry> {
    if (!this.loaded) await this.load()
    const title = this.notes.length === 0 ? 'New note' : `New note ${this.notes.length + 1}`
    const appearance: StickyNoteAppearance = {
      title,
      iconType: null,
      customSvg: null,
      color: PROJECT_COLORS[0].value
    }
    const created = await invoke('sticky-note:create', appearance)
    const entry: StickyNoteEntry = { ...created, loaded: true, loading: false, saveState: 'saved', saveError: null }
    this.notes = [...this.notes, entry]
    this.activeId = entry.id
    this.histories.set(entry.id, { undo: [], redo: [], lastRecordedAt: 0 })
    this.historyRevision += 1
    return entry
  }

  async updateAppearance(id: string, appearance: StickyNoteAppearance): Promise<void> {
    const note = this.note(id)
    if (!note) return
    await invoke('sticky-note:update', id, appearance)
    note.title = appearance.title
    note.iconType = appearance.iconType
    note.customSvg = appearance.customSvg
    note.color = appearance.color
    note.updatedAt = Date.now()
  }

  setBody(id: string, body: string): void {
    const note = this.note(id)
    if (!note?.loaded || note.body === body) return
    const now = Date.now()
    const history = this.historyFor(id)
    if (history.lastRecordedAt === 0 || now - history.lastRecordedAt > HISTORY_GROUP_DELAY_MS) {
      history.undo.push(note.body)
      if (history.undo.length > MAX_HISTORY_ENTRIES) history.undo.shift()
    }
    history.redo = []
    history.lastRecordedAt = now
    this.historyRevision += 1
    note.body = body
    note.saveState = 'pending'
    note.saveError = null
    this.scheduleSave(id)
  }

  canUndo(id: string): boolean {
    void this.historyRevision
    return (this.histories.get(id)?.undo.length ?? 0) > 0
  }

  canRedo(id: string): boolean {
    void this.historyRevision
    return (this.histories.get(id)?.redo.length ?? 0) > 0
  }

  undo(id: string): void {
    const note = this.note(id)
    const history = this.histories.get(id)
    if (!note || !history || history.undo.length === 0) return
    history.redo.push(note.body)
    note.body = history.undo.pop() ?? note.body
    history.lastRecordedAt = 0
    this.historyRevision += 1
    this.noteBodyChanged(note)
  }

  redo(id: string): void {
    const note = this.note(id)
    const history = this.histories.get(id)
    if (!note || !history || history.redo.length === 0) return
    history.undo.push(note.body)
    note.body = history.redo.pop() ?? note.body
    history.lastRecordedAt = 0
    this.historyRevision += 1
    this.noteBodyChanged(note)
  }

  async delete(id: string): Promise<void> {
    const index = this.notes.findIndex((note) => note.id === id)
    if (index < 0) return
    await invoke('sticky-note:delete', id)
    const timer = this.saveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(id)
    this.histories.delete(id)
    this.historyRevision += 1
    this.notes = this.notes.filter((note) => note.id !== id)
    if (this.activeId === id) {
      this.activeId = this.notes[Math.min(index, this.notes.length - 1)]?.id ?? null
      if (this.activeId) void this.loadBody(this.activeId)
    }
  }

  note(id: string): StickyNoteEntry | null {
    return this.notes.find((note) => note.id === id) ?? null
  }

  private async loadBody(id: string): Promise<void> {
    const note = this.note(id)
    if (!note || note.loaded || note.loading) return
    note.loading = true
    try {
      const loaded = await invoke('sticky-note:get', id)
      if (!loaded) {
        this.notes = this.notes.filter((candidate) => candidate.id !== id)
        if (this.activeId === id) this.activeId = this.notes[0]?.id ?? null
        return
      }
      note.body = loaded.body
      note.updatedAt = loaded.updatedAt
      note.loaded = true
      note.saveState = 'saved'
      note.saveError = null
      this.histories.set(id, { undo: [], redo: [], lastRecordedAt: 0 })
      this.historyRevision += 1
    } catch (error) {
      note.saveError = error instanceof Error ? error.message : 'Could not load this sticky note'
      note.saveState = 'error'
    } finally {
      note.loading = false
    }
  }

  private historyFor(id: string): NoteHistory {
    let history = this.histories.get(id)
    if (!history) {
      history = { undo: [], redo: [], lastRecordedAt: 0 }
      this.histories.set(id, history)
    }
    return history
  }

  private noteBodyChanged(note: StickyNoteEntry): void {
    note.saveState = 'pending'
    note.saveError = null
    this.scheduleSave(note.id)
  }

  private scheduleSave(id: string): void {
    const previous = this.saveTimers.get(id)
    if (previous) clearTimeout(previous)
    this.saveTimers.set(
      id,
      setTimeout(() => {
        this.saveTimers.delete(id)
        void this.persistBody(id)
      }, AUTOSAVE_DELAY_MS)
    )
  }

  private async persistBody(id: string): Promise<void> {
    const note = this.note(id)
    if (!note?.loaded) return
    if (this.inFlightSaves.has(id)) {
      this.scheduleSave(id)
      return
    }
    this.inFlightSaves.add(id)
    const body = note.body
    note.saveState = 'saving'
    note.saveError = null
    try {
      await invoke('sticky-note:save', id, body)
      if (note.body === body) {
        note.saveState = 'saved'
        note.updatedAt = Date.now()
      } else {
        note.saveState = 'pending'
      }
    } catch (error) {
      note.saveState = 'error'
      note.saveError = error instanceof Error ? error.message : 'Could not save this sticky note'
    } finally {
      this.inFlightSaves.delete(id)
    }
  }
}

export const stickyNotes = new StickyNotesState()
