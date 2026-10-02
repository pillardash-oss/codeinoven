import { invoke } from '$lib/ipc.svelte'
import { PROJECT_COLORS } from '$lib/project-colors'
import type { StickyNoteAppearance, StickyNoteSummary } from '$shared/types'

export interface StickyNoteEntry extends StickyNoteSummary {
  body: string
  imageUrl: string | null
  loaded: boolean
  loading: boolean
  saveError: string | null
}

const AUTOSAVE_DELAY_MS = 3000

function asEntry(summary: StickyNoteSummary): StickyNoteEntry {
  return {
    ...summary,
    body: '',
    imageUrl: null,
    loaded: false,
    loading: false,
    saveError: null
  }
}

class StickyNotesState {
  private notes = $state<StickyNoteEntry[]>([])
  private activeId = $state<string | null>(null)
  private loaded = $state(false)
  private loading = $state(false)
  private loadError = $state<string | null>(null)
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private inFlightSaves = new Set<string>()
  private loadingImages = new Set<string>()
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
        for (const note of this.notes) {
          if (note.imagePath) void this.loadImage(note.id)
        }
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
      imagePath: null,
      color: PROJECT_COLORS[0].value
    }
    const created = await invoke('sticky-note:create', appearance)
    const entry: StickyNoteEntry = {
      ...created,
      imageUrl: null,
      loaded: true,
      loading: false,
      saveError: null
    }
    this.notes = [...this.notes, entry]
    this.activeId = entry.id
    return entry
  }

  async updateAppearance(
    id: string,
    appearance: StickyNoteAppearance,
    imageUrl: string | null
  ): Promise<void> {
    const note = this.note(id)
    if (!note) return
    await invoke('sticky-note:update', id, appearance)
    note.title = appearance.title
    note.iconType = appearance.iconType
    note.customSvg = appearance.customSvg
    note.imagePath = appearance.imagePath
    note.imageUrl = imageUrl
    note.color = appearance.color
    note.updatedAt = Date.now()
    if (note.imagePath && !note.imageUrl) void this.loadImage(id)
  }

  setBody(id: string, body: string): void {
    const note = this.note(id)
    if (!note?.loaded || note.body === body) return
    note.body = body
    note.saveError = null
    this.scheduleSave(id)
  }

  async delete(id: string): Promise<void> {
    const index = this.notes.findIndex((note) => note.id === id)
    if (index < 0) return
    await invoke('sticky-note:delete', id)
    const timer = this.saveTimers.get(id)
    if (timer) clearTimeout(timer)
    this.saveTimers.delete(id)
    this.loadingImages.delete(id)
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
      note.saveError = null
    } catch (error) {
      note.saveError = error instanceof Error ? error.message : 'Could not load this sticky note'
    } finally {
      note.loading = false
    }
  }

  private async loadImage(id: string): Promise<void> {
    const note = this.note(id)
    if (!note?.imagePath || note.imageUrl || this.loadingImages.has(id)) return
    this.loadingImages.add(id)
    try {
      note.imageUrl = await invoke('file:readAsDataUrl', note.imagePath)
    } catch {
      note.imageUrl = null
    } finally {
      this.loadingImages.delete(id)
    }
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
    note.saveError = null
    try {
      await invoke('sticky-note:save', id, body)
      if (note.body === body) {
        note.updatedAt = Date.now()
      }
    } catch (error) {
      note.saveError = error instanceof Error ? error.message : 'Could not save this sticky note'
    } finally {
      this.inFlightSaves.delete(id)
    }
  }
}

export const stickyNotes = new StickyNotesState()
