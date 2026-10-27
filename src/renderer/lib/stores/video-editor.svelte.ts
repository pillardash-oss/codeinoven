import { invoke, subscribe } from '$lib/ipc.svelte'
import { VideoFrameSeeker } from '$lib/video-frame-seeker'
import {
  validateVideoStudio,
  type VideoCaption,
  type VideoStudioDocument
} from '$shared/video/studio'
import {
  VIDEO_CAPTION_APPEARANCE,
  newVideoEditClip,
  removeVideoEditClip,
  snapEditTime,
  splitVideoEditClip,
  trimVideoEditClip,
  type VideoEditClip,
  type VideoEditDocument,
  type VideoEditRegion,
  type VideoEditorGesture,
  type VideoEditorSelection
} from '$shared/video/edit'
import type { VideoProjectManifest } from '$shared/video/project'
import type { BrowserCompositionPlayback } from '$shared/ipc-contract'
import { visibleVideoFrames, type VideoFrameThumbnail } from '$shared/video/frame-grid'

// eslint-disable-next-line svelte/prefer-svelte-reactivity -- Ownership registry, not rendered state.
const controllers = new Map<string, VideoEditorController>()
type DocumentEdit = (document: VideoStudioDocument, edit: VideoEditDocument) => void

/** One document and undo chain, shared by the board and its fullscreen editor. */
export class VideoEditorController {
  document = $state.raw<VideoStudioDocument | null>(null)
  manifest = $state.raw<VideoProjectManifest | null>(null)
  selection = $state.raw<VideoEditorSelection>(null)
  contextRequest = $state.raw<{ x: number; y: number } | null>(null)
  private copiedClip = $state.raw<VideoEditClip | null>(null)
  time = $state(0)
  playing = $state(false)
  loading = $state(false)
  saving = $state(false)
  importing = $state(false)
  private draftDirty = $state(false)
  get dirty(): boolean {
    return this.draftDirty
  }
  set dirty(value: boolean) {
    this.draftDirty = value
    for (const handle of this.handles.values()) handle.onDirtyChange?.(value)
  }
  error = $state('')
  externalChange = $state(false)
  private revision = ''
  private undoEntries = $state.raw<string[]>([])
  private redoEntries = $state.raw<string[]>([])
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- Lifecycle handles never drive template output.
  private handles = new Map<
    symbol,
    { tabId: string; active: boolean; onDirtyChange?: (dirty: boolean) => void }
  >()
  private unsubscribe: (() => void)[] = []
  private poll: ReturnType<typeof setInterval> | undefined
  private previewTimer: ReturnType<typeof setTimeout> | undefined
  private previewBusy = false
  private previewAgain = false
  private reading = false
  private disposed = false
  private gestureBefore: string | null = null
  private gestureWasDirty = false
  waveforms = $state.raw<Record<string, string | null>>({})
  private waveformBusy = false
  frames = $state.raw<VideoFrameThumbnail[]>([])
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  private frameBusy = false
  private frameRequest: number[] | null = null
  private frameDocument: VideoStudioDocument | null = null
  private frameRange: [number, number, number] | null = null
  requestFrames(start: number, end: number, contentWidth: number): void {
    if (!this.tabId || !this.document?.edit) return
    this.frameRange = [start, end, contentWidth]
    this.frameRequest = visibleVideoFrames(this.duration, this.fps, start, end, contentWidth)
      .map((cell) => cell.time)
      .filter((time) => !this.frames.some((frame) => frame.time === time))
    clearTimeout(this.frameTimer)
    this.frameTimer = setTimeout(() => {
      void this.flushFrames()
    }, 300)
  }
  private async flushFrames(): Promise<void> {
    if (this.frameBusy || !this.tabId || !this.frameRequest?.length) return
    const times = this.frameRequest
    const document = this.document
    this.frameRequest = null
    this.frameBusy = true
    try {
      const frames = await invoke(
        'video:frameStrip',
        this.projectId,
        this.threadId,
        this.directory,
        times,
        document ?? undefined
      )
      if (!this.disposed && this.document === document)
        this.frames = Object.values(
          Object.fromEntries([...this.frames, ...frames].map((frame) => [frame.time, frame]))
        )
          .slice(-96)
          .sort((a, b) => a.time - b.time)
    } catch {
      /* A composition still loading can retry when the viewport moves. */
    } finally {
      this.frameBusy = false
      queueMicrotask(() => {
        if (this.frameRequest?.length && this.tabId) void this.flushFrames()
      })
    }
  }
  private seeker = new VideoFrameSeeker(
    (tabId, time) => invoke('browser:transport', tabId, 'seek', time),
    (_tabId, state) => this.adoptPlayback(state)
  )

  constructor(
    readonly projectId: string,
    readonly threadId: string,
    readonly directory: string,
    private readonly release: () => void
  ) {}
  get edit(): VideoEditDocument | null {
    return this.document?.edit ?? null
  }
  get duration(): number {
    return this.edit?.duration ?? this.manifest?.duration ?? 1
  }
  get fps(): number {
    return this.manifest?.fps ?? 30
  }
  get canUndo(): boolean {
    return this.undoEntries.length > 0
  }
  get canRedo(): boolean {
    return this.redoEntries.length > 0
  }
  get canPaste(): boolean {
    return this.copiedClip !== null
  }
  copy(): void {
    if (this.selectedClip) this.copiedClip = structuredClone(this.selectedClip)
  }
  paste(): void {
    if (!this.copiedClip) return
    const copied = this.copiedClip
    this.mutate((_doc, edit) => {
      const track = edit.tracks.find((track) => track.id === copied.trackId)
      if (!track || track.locked) throw new Error('Unlock the destination track before pasting')
      const clip = structuredClone(copied)
      clip.id = crypto.randomUUID()
      clip.start = Math.min(3600 - clip.duration, this.time)
      edit.clips.push(clip)
      edit.duration = Math.max(edit.duration, clip.start + clip.duration)
      this.selection = { kind: 'clip', id: clip.id }
    })
  }
  get tabId(): string {
    return [...this.handles.values()].find((handle) => handle.active && handle.tabId)?.tabId ?? ''
  }
  get selectedClip(): VideoEditClip | null {
    const selection = this.selection
    return selection?.kind === 'clip'
      ? (this.edit?.clips.find((clip) => clip.id === selection.id) ?? null)
      : null
  }
  waveformKey(clip: VideoEditClip): string {
    return `${clip.assetId}:${clip.sourceStart}:${clip.duration * clip.speed}`
  }
  private async requestWaveforms(): Promise<void> {
    if (this.waveformBusy || !this.tabId || !this.edit) return
    this.waveformBusy = true
    try {
      const clips = this.edit.clips
        .filter((clip) => this.edit?.assets.find((asset) => asset.id === clip.assetId)?.hasAudio)
        .slice(0, 24)
      for (const clip of clips) {
        if (!this.tabId || this.disposed) return
        const key = this.waveformKey(clip)
        if (key in this.waveforms) continue
        const asset = this.edit?.assets.find((asset) => asset.id === clip.assetId)
        if (!asset) continue
        const picture = await invoke(
          'video:waveform',
          this.projectId,
          this.threadId,
          this.directory,
          asset.source,
          clip.sourceStart,
          clip.duration * clip.speed
        ).catch(() => null)
        if (this.disposed) return
        const entries = Object.entries(this.waveforms).slice(-23)
        this.waveforms = { ...Object.fromEntries(entries), [key]: picture }
      }
    } finally {
      this.waveformBusy = false
    }
  }
  get selectedRegion(): VideoEditRegion | null {
    const selection = this.selection
    return selection?.kind === 'region'
      ? (this.edit?.regions.find((region) => region.id === selection.id) ?? null)
      : null
  }
  get selectedCaption(): VideoCaption | null {
    const selection = this.selection
    return selection?.kind === 'caption' ? (this.document?.captions[selection.index] ?? null) : null
  }

  attach(tabId: string, active: boolean, onDirtyChange?: (dirty: boolean) => void): () => void {
    const id = Symbol('video-editor')
    this.handles.set(id, { tabId, active, onDirtyChange })
    // Start subscriptions after attachment setup. Lifecycle methods deliberately
    // run outside Svelte's attachment dependency collection.
    queueMicrotask(() => {
      if (!this.handles.has(id) || this.disposed) return
      onDirtyChange?.(this.dirty)
      if (this.unsubscribe.length === 0) {
        this.unsubscribe = [
          subscribe('video:gesture', (projectId, threadId, directory, gesture) => {
            if (this.matches(projectId, threadId, directory)) this.applyGesture(gesture)
          }),
          subscribe('design:historyChanged', (projectId, directory) => {
            if (
              projectId !== this.projectId ||
              directory !== this.directory ||
              this.saving ||
              this.loading
            )
              return
            if (this.dirty) this.externalChange = true
            else void this.load(false)
          }),
          subscribe('browser:state', (state) => {
            if (state.tabId === this.tabId && !state.loading) this.queuePreview()
          })
        ]
        if (!this.document) void this.load(true)
      }
      this.syncActivity()
    })
    return () => {
      this.handles.delete(id)
      if (this.handles.size === 0)
        queueMicrotask(() => {
          if (this.handles.size === 0) this.dispose()
        })
      else queueMicrotask(() => this.syncActivity())
    }
  }
  private matches(projectId: string, threadId: string, directory: string): boolean {
    return (
      projectId === this.projectId && threadId === this.threadId && directory === this.directory
    )
  }
  private syncActivity(): void {
    clearInterval(this.poll)
    this.poll = undefined
    if (this.tabId && !this.disposed) {
      void this.readPlayback()
      this.poll = setInterval(() => {
        void this.readPlayback()
      }, 250)
      this.queuePreview()
    } else if (this.document)
      void invoke('video:stopEditing', this.projectId, this.threadId, this.directory).catch(
        () => undefined
      )
  }
  private adoptPlayback(state: BrowserCompositionPlayback): void {
    this.time = state.time
    this.playing = state.playing
    if (state.error) this.error = state.error
  }
  private async readPlayback(): Promise<void> {
    if (this.reading || !this.tabId) return
    this.reading = true
    try {
      const state = await invoke('browser:transportState', this.tabId)
      if (state && !this.disposed && !this.gestureBefore) this.adoptPlayback(state)
    } catch {
      /* A board changing folders releases this view. */
    } finally {
      this.reading = false
    }
  }

  async load(enable: boolean): Promise<void> {
    if (this.loading) return
    this.loading = true
    this.error = ''
    try {
      const result = enable
        ? await invoke('video:editorEnable', this.projectId, this.threadId, this.directory)
        : await invoke('video:studio', this.projectId, this.threadId, this.directory)
      if (this.disposed) return
      this.document = result.document
      this.manifest = result.manifest
      this.revision = result.revision
      this.dirty = false
      this.externalChange = false
      if (enable && this.tabId) await invoke('browser:reload', this.tabId)
      this.queuePreview()
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.loading = false
    }
  }
  select(selection: VideoEditorSelection, seekTo?: number): void {
    this.selection = selection
    if (seekTo !== undefined) this.seek(seekTo)
    this.queuePreview()
  }
  seek(seconds: number): void {
    this.time = Math.min(this.duration, snapEditTime(seconds, this.fps))
    if (this.tabId) this.seeker.seek(this.tabId, this.time)
  }
  async togglePlayback(): Promise<void> {
    if (!this.tabId) return
    try {
      const state = await invoke('browser:transport', this.tabId, 'toggle', 0)
      if (state) this.adoptPlayback(state)
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  private pushUndo(before: string): void {
    const entries = [...this.undoEntries, before]
    let bytes = entries.reduce((sum, entry) => sum + entry.length * 2, 0)
    while (entries.length > 30 || (entries.length > 1 && bytes > 8 * 1024 * 1024))
      bytes -= entries.shift()!.length * 2
    this.undoEntries = entries
    this.redoEntries = []
  }
  mutate(change: DocumentEdit): void {
    if (!this.document?.edit || this.saving) return
    const before = JSON.stringify(this.document)
    try {
      const next = JSON.parse(before) as VideoStudioDocument
      change(next, next.edit!)
      const after = validateVideoStudio(next)
      if (before === JSON.stringify(after)) return
      this.pushUndo(before)
      this.document = after
      this.dirty = true
      this.error = ''
      this.queuePreview()
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    }
  }
  beginGesture(): void {
    if (this.document && !this.gestureBefore) {
      this.gestureBefore = JSON.stringify(this.document)
      this.gestureWasDirty = this.dirty
    }
  }
  updateGesture(change: DocumentEdit): void {
    if (!this.gestureBefore) this.beginGesture()
    if (!this.gestureBefore) return
    try {
      const next = JSON.parse(this.gestureBefore) as VideoStudioDocument
      if (!next.edit) return
      change(next, next.edit)
      this.document = validateVideoStudio(next)
      this.dirty = true
      this.queuePreview()
    } catch {
      /* Keep the last valid frame while the pointer is outside the range. */
    }
  }
  finishGesture(cancel = false): void {
    const before = this.gestureBefore
    this.gestureBefore = null
    if (!before) return
    if (cancel) {
      this.document = JSON.parse(before) as VideoStudioDocument
      this.dirty = this.gestureWasDirty
    } else if (before !== JSON.stringify(this.document)) this.pushUndo(before)
    this.queuePreview()
  }
  undo(): void {
    if (this.gestureBefore) this.finishGesture()
    const before = this.undoEntries.at(-1)
    if (!before || !this.document) return
    this.redoEntries = [...this.redoEntries, JSON.stringify(this.document)]
    this.undoEntries = this.undoEntries.slice(0, -1)
    this.document = JSON.parse(before) as VideoStudioDocument
    this.dirty = true
    this.retainSelection()
    this.queuePreview()
  }
  redo(): void {
    const next = this.redoEntries.at(-1)
    if (!next || !this.document) return
    this.undoEntries = [...this.undoEntries, JSON.stringify(this.document)]
    this.redoEntries = this.redoEntries.slice(0, -1)
    this.document = JSON.parse(next) as VideoStudioDocument
    this.dirty = true
    this.retainSelection()
    this.queuePreview()
  }

  split(all = false): void {
    const selected = this.selectedClip?.id
    this.mutate((_doc, edit) => {
      const clips = all ? [...edit.clips] : edit.clips.filter((clip) => clip.id === selected)
      for (const clip of clips) splitVideoEditClip(edit, clip.id, this.time, this.fps)
    })
  }
  private retainSelection(): void {
    const selection = this.selection
    if (!selection || !this.document?.edit) return
    if (
      selection.kind === 'clip' &&
      !this.document.edit.clips.some((clip) => clip.id === selection.id)
    )
      this.selection = null
    if (
      selection.kind === 'region' &&
      !this.document.edit.regions.some((region) => region.id === selection.id)
    )
      this.selection = null
    if (selection.kind === 'caption' && !this.document.captions[selection.index])
      this.selection = null
  }
  duplicateTrack(id: string): void {
    this.mutate((_doc, edit) => {
      const track = edit.tracks.find((track) => track.id === id)
      if (!track || track.locked) return
      const copy = { ...track, id: crypto.randomUUID(), name: `${track.name} copy` }
      edit.tracks.splice(edit.tracks.indexOf(track) + 1, 0, copy)
      edit.clips.push(
        ...edit.clips
          .filter((clip) => clip.trackId === id)
          .map((clip) => ({ ...structuredClone(clip), id: crypto.randomUUID(), trackId: copy.id }))
      )
    })
  }
  duplicate(): void {
    const selection = this.selection
    if (!selection) return
    if (selection.kind === 'caption') {
      this.mutate((doc, edit) => {
        const selected = doc.captions[selection.index]
        if (!selected) return
        const clone = structuredClone(selected)
        const offset = selected.end - selected.start
        clone.start += offset
        clone.end += offset
        clone.words = clone.words?.map((word) => ({
          ...word,
          start: word.start + offset,
          end: word.end + offset
        }))
        doc.captions.push(clone)
        doc.captions.sort((a, b) => a.start - b.start)
        edit.duration = Math.max(edit.duration, clone.end)
        this.selection = { kind: 'caption', index: doc.captions.indexOf(clone) }
      })
      return
    }
    if (selection.kind === 'region') {
      this.mutate((_doc, edit) => {
        const selected = edit.regions.find((region) => region.id === selection.id)
        if (!selected) return
        const clone = {
          ...selected,
          id: crypto.randomUUID(),
          start: selected.start + selected.duration
        }
        edit.regions.push(clone)
        edit.duration = Math.max(edit.duration, clone.start + clone.duration)
        this.selection = { kind: 'region', id: clone.id }
      })
      return
    }
    const selected = this.selectedClip
    if (!selected) return
    this.mutate((_doc, edit) => {
      const clone = structuredClone(selected)
      clone.id = crypto.randomUUID()
      clone.start += clone.duration
      edit.duration = Math.max(edit.duration, clone.start + clone.duration)
      edit.clips.push(clone)
      this.selection = { kind: 'clip', id: clone.id }
    })
  }
  remove(ripple = false): void {
    const selection = this.selection
    if (!selection) return
    this.mutate((doc, edit) => {
      if (selection.kind === 'clip') removeVideoEditClip(edit, selection.id, ripple)
      if (selection.kind === 'region')
        edit.regions = edit.regions.filter((region) => region.id !== selection.id)
      if (selection.kind === 'caption') doc.captions.splice(selection.index, 1)
      this.selection = null
    })
  }
  moveClip(id: string, start: number, trackId: string): void {
    this.updateGesture((_doc, edit) => {
      const clip = edit.clips.find((clip) => clip.id === id),
        track = edit.tracks.find((track) => track.id === trackId)
      if (
        !clip ||
        !track ||
        track.locked ||
        track.kind !== edit.tracks.find((item) => item.id === clip.trackId)?.kind ||
        edit.tracks.find((track) => track.id === clip.trackId)?.locked
      )
        return
      clip.start = Math.min(3600 - clip.duration, snapEditTime(start, this.fps))
      clip.trackId = trackId
      edit.duration = Math.max(edit.duration, clip.start + clip.duration)
    })
  }
  trimClip(id: string, edge: 'start' | 'end', at: number): void {
    this.updateGesture((_doc, edit) => trimVideoEditClip(edit, id, edge, at, this.fps))
  }
  editClip(id: string, change: (clip: VideoEditClip) => void): void {
    this.mutate((_doc, edit) => {
      const clip = edit.clips.find((clip) => clip.id === id)
      if (!clip || edit.tracks.find((track) => track.id === clip.trackId)?.locked) return
      change(clip)
      edit.duration = Math.max(edit.duration, clip.start + clip.duration)
    })
  }
  addTrack(kind: 'video' | 'audio' | 'overlay'): void {
    this.mutate((_doc, edit) =>
      edit.tracks.push({
        id: crypto.randomUUID(),
        kind,
        name: kind === 'video' ? 'Video' : kind === 'audio' ? 'Audio' : 'Overlays',
        locked: false,
        muted: false,
        hidden: false
      })
    )
  }
  addAsset(assetId: string, at = this.time, targetTrack?: string): void {
    this.mutate((_doc, edit) => {
      const asset = edit.assets.find((asset) => asset.id === assetId)
      if (!asset) return
      const kind = asset.kind === 'audio' ? 'audio' : asset.kind === 'image' ? 'overlay' : 'video'
      const track = targetTrack
        ? edit.tracks.find((track) => track.id === targetTrack)
        : edit.tracks.find((track) => track.kind === kind && !track.locked)
      if (!track || track.locked || track.kind !== kind)
        throw new Error('Choose an unlocked track with the same media type')
      const clip = newVideoEditClip(asset, track.id, snapEditTime(at, this.fps))
      if (asset.kind === 'image') clip.rect = { x: 0.65, y: 0.65, width: 0.25, height: 0.25 }
      edit.clips.push(clip)
      edit.duration = Math.max(edit.duration, clip.start + clip.duration)
      this.selection = { kind: 'clip', id: clip.id }
    })
  }
  addRegion(kind: VideoEditRegion['kind'] = 'blur'): void {
    this.mutate((_doc, edit) => {
      const region: VideoEditRegion = {
        id: crypto.randomUUID(),
        kind,
        start: Math.min(this.time, edit.duration - 0.01),
        duration: Math.min(5, Math.max(0.01, edit.duration - this.time)),
        x: 0.3,
        y: 0.3,
        width: 0.3,
        height: 0.2,
        amount: 30,
        color: '#000000'
      }
      edit.regions.push(region)
      this.selection = { kind: 'region', id: region.id }
    })
  }
  private applyGesture(gesture: VideoEditorGesture): void {
    if (gesture.kind) {
      // The native stage already painted its selection. Do not replace its document mid-drag.
      this.selection = gesture.selection
      if (gesture.kind === 'context' && gesture.point) this.contextRequest = { ...gesture.point }
      return
    }
    this.mutate((doc, edit) => {
      const target = gesture.selection
      if (target.kind === 'clip') {
        const clip = edit.clips.find((clip) => clip.id === target.id)
        if (clip && !edit.tracks.find((track) => track.id === clip.trackId)?.locked)
          clip.rect = gesture.rect
      } else if (target.kind === 'region') {
        const region = edit.regions.find((region) => region.id === target.id)
        if (region) Object.assign(region, gesture.rect)
      } else {
        const caption = doc.captions[target.index]
        if (caption)
          caption.appearance = gesture.captionAppearance ?? {
            ...VIDEO_CAPTION_APPEARANCE,
            ...doc.captionAppearance,
            ...caption.appearance,
            x: Math.min(1, Math.max(0, gesture.rect.x + gesture.rect.width / 2)),
            y: Math.min(1, Math.max(0, gesture.rect.y + gesture.rect.height / 2)),
            width: Math.min(1, Math.max(0.1, gesture.rect.width))
          }
      }
    })
  }

  async importFiles(paths?: string[], at?: number, trackId?: string): Promise<void> {
    if (this.importing) return
    this.importing = true
    this.error = ''
    try {
      const chosen =
        paths ??
        (await invoke('dialog:pickFiles', {
          kind: 'project',
          projectId: this.projectId,
          threadId: this.threadId
        }))
      if (!chosen.length) return
      const assets = await invoke(
        'video:importAssets',
        this.projectId,
        this.threadId,
        this.directory,
        chosen
      )
      this.mutate((_doc, edit) => edit.assets.push(...assets))
      if (at !== undefined) {
        let time = at
        for (const asset of assets) {
          this.addAsset(asset.id, time, trackId)
          time += Math.min(asset.duration, asset.kind === 'image' ? 5 : asset.duration)
        }
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.importing = false
    }
  }
  async dropFiles(files: File[], at?: number, trackId?: string): Promise<void> {
    try {
      const paths: string[] = []
      for (const file of files.slice(0, 16)) {
        const path = await window.api.registerFileSelection(file, {
          kind: 'project',
          projectId: this.projectId,
          threadId: this.threadId
        })
        if (path) paths.push(path)
      }
      if (paths.length) await this.importFiles(paths, at, trackId)
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async save(): Promise<boolean> {
    if (!this.document || this.saving || !this.dirty) return !this.dirty
    this.saving = true
    this.error = ''
    try {
      const result = await invoke(
        'video:save',
        this.projectId,
        this.threadId,
        this.directory,
        this.document,
        this.revision
      )
      if (this.disposed) return false
      this.document = result.document
      this.manifest = result.manifest
      this.revision = result.revision
      this.dirty = false
      this.externalChange = false
      this.queuePreview()
      return true
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
      return false
    } finally {
      this.saving = false
    }
  }

  queuePreview(): void {
    if (this.frameDocument !== this.document) {
      this.frameDocument = this.document
      this.frames = []
      if (this.frameRange) this.requestFrames(...this.frameRange)
    }
    if (this.disposed || !this.document || !this.tabId) return
    this.previewAgain = true
    if (!this.previewTimer && !this.previewBusy)
      this.previewTimer = setTimeout(() => {
        this.previewTimer = undefined
        void this.flushPreview()
      }, 120)
  }
  private async flushPreview(): Promise<void> {
    if (this.disposed || !this.document || !this.tabId || this.previewBusy) return
    this.previewBusy = true
    this.previewAgain = false
    try {
      await invoke(
        'video:preview',
        this.projectId,
        this.threadId,
        this.directory,
        this.document,
        this.selection
      )
      void this.requestWaveforms()
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      this.previewBusy = false
      if (this.previewAgain) this.queuePreview()
    }
  }
  private dispose(): void {
    clearInterval(this.poll)
    clearTimeout(this.previewTimer)
    clearTimeout(this.frameTimer)
    this.frameRequest = null
    this.seeker.clear()
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.unsubscribe = []
    void invoke('video:stopEditing', this.projectId, this.threadId, this.directory).catch(
      () => undefined
    )
    // A folder switch must not throw away an unsaved cut. Dormant drafts have
    // no timers, bridge or subscriptions and are reused when the folder returns.
    if (!this.dirty) {
      this.disposed = true
      this.release()
    }
  }
}

export function videoEditorController(
  projectId: string,
  threadId: string,
  directory: string
): VideoEditorController {
  const key = JSON.stringify([projectId, threadId, directory])
  let controller = controllers.get(key)
  if (!controller) {
    controller = new VideoEditorController(projectId, threadId, directory, () =>
      controllers.delete(key)
    )
    controllers.set(key, controller)
  }
  return controller
}
