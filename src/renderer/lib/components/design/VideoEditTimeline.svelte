<script lang="ts">
  import { onMount, tick, type Snippet } from 'svelte'
  import { on } from 'svelte/events'
  import { ContextMenu } from 'bits-ui'
  import { createAttachmentKey } from 'svelte/attachments'
  import { browserVisibility, trackBrowserOcclusion } from '$lib/stores/browser-visibility.svelte'
  import StudioSidebarResizeHandle from '$lib/components/specs/StudioSidebarResizeHandle.svelte'
  import CioLock from '@pdslng/cio-icon/CioLock.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import type { VideoEditorController } from '$lib/stores/video-editor.svelte'
  import { snapEditTime } from '$shared/video/edit'
  import { videoTimecode } from '$shared/video/timeline'
  import { visibleVideoFrames } from '$shared/video/frame-grid'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  let {
    editor,
    tools,
    contextActions
  }: { editor: VideoEditorController; tools?: Snippet; contextActions?: Snippet } = $props()
  let labelWidth = $state(160)
  let rowHeights = $state<Record<string, number>>({})
  let contextTrack = $state('')
  let draggedTrack = ''
  let hoverTime = $state<number | null>(null)
  const occlusion = { [createAttachmentKey()]: trackBrowserOcclusion }
  const stageContext = {
    [createAttachmentKey()]: (element: HTMLElement) => {
      const request = editor.contextRequest
      if (!request) return
      queueMicrotask(() => {
        const bounds = browserVisibility.pageBoundsFor(editor.tabId)
        if (!bounds) return
        element.dispatchEvent(
          new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            button: 2,
            clientX: bounds.x + request.x * bounds.width,
            clientY: bounds.y + request.y * bounds.height
          })
        )
        if (editor.contextRequest === request) editor.contextRequest = null
      })
    }
  }
  const trackHeight = (id: string): number => rowHeights[id] ?? 64
  function rememberRows(): void {
    localStorage.setItem('cio:video-editor-tracks', JSON.stringify({ labelWidth, rowHeights }))
  }
  onMount(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('cio:video-editor-tracks') ?? 'null')
      if (!raw || typeof raw !== 'object') return
      const saved = raw as Record<string, unknown>
      if (typeof saved.labelWidth === 'number' && Number.isFinite(saved.labelWidth))
        labelWidth = Math.max(112, Math.min(320, saved.labelWidth))
      if (saved.rowHeights && typeof saved.rowHeights === 'object')
        rowHeights = Object.fromEntries(
          Object.entries(saved.rowHeights)
            .slice(0, 32)
            .filter(
              (entry): entry is [string, number] =>
                typeof entry[1] === 'number' && Number.isFinite(entry[1])
            )
            .map(([key, height]) => [key, Math.max(40, Math.min(220, height))])
        )
    } catch {
      /* Invalid preferences do not block editing. */
    }
  })
  function reorderTrack(id: string, targetId: string): void {
    editor.mutate((_doc, edit) => {
      const from = edit.tracks.findIndex((item) => item.id === id)
      const to = edit.tracks.findIndex((item) => item.id === targetId)
      if (from < 0 || to < 0 || from === to) return
      const [track] = edit.tracks.splice(from, 1)
      edit.tracks.splice(to, 0, track)
    })
  }
  function shiftTrack(direction: number): void {
    const tracks = editor.edit?.tracks ?? []
    const index = tracks.findIndex((track) => track.id === contextTrack)
    if (tracks[index + direction]) reorderTrack(contextTrack, tracks[index + direction].id)
  }
  let viewport: HTMLDivElement | undefined
  let width = $state(500)
  let scrollLeft = $state(0)
  let zoom = $state(1)
  const pixelsPerSecond = $derived(Math.max(0.1, (width - 8) / Math.max(1, editor.duration)) * zoom)
  const contentWidth = $derived(
    Math.min(180000, Math.max(width, editor.duration * pixelsPerSecond))
  )
  const scale = $derived(contentWidth / editor.duration)
  const start = $derived(scrollLeft / scale)
  const end = $derived((scrollLeft + width) / scale)
  const frameCells = $derived(
    visibleVideoFrames(editor.duration, editor.fps, start, end, contentWidth)
  )
  const pendingChanges = $derived(
    editor.edit?.changes.filter((change) => change.author === 'agent' && !change.reviewed) ?? []
  )
  const visibleClips = $derived.by(() => {
    const items =
      editor.edit?.clips.filter(
        (clip) => clip.start + clip.duration >= start && clip.start <= end
      ) ?? []
    const stride = Math.max(1, Math.ceil(items.length / 500))
    return items.filter(
      (clip, index) =>
        index % stride === 0 ||
        (editor.selection?.kind === 'clip' && editor.selection.id === clip.id)
    )
  })
  const visibleCaptions = $derived.by(() => {
    const items: {
      caption: NonNullable<typeof editor.document>['captions'][number]
      index: number
    }[] = []
    for (const [index, caption] of (editor.document?.captions ?? []).entries())
      if (caption.end >= start && caption.start <= end) items.push({ caption, index })
    const stride = Math.max(1, Math.ceil(items.length / 300))
    return items.filter(
      (item, index) =>
        index % stride === 0 ||
        (editor.selection?.kind === 'caption' && editor.selection.index === item.index)
    )
  })
  const tickStep = $derived(
    [1 / editor.fps, 0.1, 0.5, 1, 5, 10, 30, 60, 300, 600].find((step) => step * scale >= 65) ?? 600
  )
  const ticks = $derived(
    Array.from(
      { length: Math.min(80, Math.ceil((end - start) / tickStep) + 2) },
      (_, index) => (Math.floor(start / tickStep) + index) * tickStep
    ).filter((time) => time <= editor.duration)
  )
  let drag: {
    kind: 'clip' | 'caption' | 'region'
    id: string
    index: number
    x: number
    start: number
    end: number
    edge: 'start' | 'end' | null
    trackId: string
  } | null = null
  let scrubbing = false
  let gestureZoom = 1
  async function zoomAt(next: number, clientX?: number): Promise<void> {
    if (!viewport) return
    const offset =
      clientX === undefined
        ? width / 2
        : Math.max(0, Math.min(width, clientX - viewport.getBoundingClientRect().left))
    const anchor = (viewport.scrollLeft + offset) / scale
    zoom = Math.max(1, Math.min(1000, next))
    await tick()
    if (viewport) viewport.scrollLeft = Math.max(0, anchor * scale - offset)
    editor.requestFrames(start, end, contentWidth)
  }
  function wheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    void zoomAt(
      zoom * Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.08 : 0.008)),
      event.clientX
    )
  }

  function at(event: { clientX: number }): number {
    if (!viewport) return 0
    return snapEditTime(
      (event.clientX - viewport.getBoundingClientRect().left + viewport.scrollLeft) / scale,
      editor.fps
    )
  }
  function startClip(event: PointerEvent, id: string): void {
    if (event.button !== 0) return
    const clip = editor.edit?.clips.find((clip) => clip.id === id)
    if (!clip || editor.edit?.tracks.find((track) => track.id === clip.trackId)?.locked) return
    event.preventDefault()
    event.stopPropagation()
    const target =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-trim]') : null
    const edge =
      target?.dataset.trim === 'start' ? 'start' : target?.dataset.trim === 'end' ? 'end' : null
    drag = {
      kind: 'clip',
      id,
      index: -1,
      x: event.clientX,
      start: clip.start,
      end: clip.start + clip.duration,
      edge,
      trackId: clip.trackId
    }
    editor.select({ kind: 'clip', id })
    editor.beginGesture()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function startBand(
    event: PointerEvent,
    kind: 'caption' | 'region',
    id: string,
    index: number,
    from: number,
    to: number
  ): void {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const target =
      event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-trim]') : null
    const edge =
      target?.dataset.trim === 'start' ? 'start' : target?.dataset.trim === 'end' ? 'end' : null
    drag = { kind, id, index, x: event.clientX, start: from, end: to, edge, trackId: '' }
    editor.select(kind === 'caption' ? { kind, index } : { kind, id })
    editor.beginGesture()
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  }
  function move(event: PointerEvent): void {
    if (!drag) return
    const active = drag,
      delta = (event.clientX - active.x) / scale
    if (active.kind === 'clip') {
      if (active.edge)
        editor.trimClip(
          active.id,
          active.edge,
          (active.edge === 'start' ? active.start : active.end) + delta
        )
      else {
        const track =
          document
            .elementFromPoint(event.clientX, event.clientY)
            ?.closest<HTMLElement>('[data-video-track]')?.dataset.videoTrack ?? active.trackId
        editor.moveClip(active.id, active.start + delta, track)
      }
    } else
      editor.updateGesture((doc, edit) => {
        const previousEnd =
          active.kind === 'caption' ? (doc.captions[active.index - 1]?.end ?? 0) : 0
        const nextStart =
          active.kind === 'caption'
            ? (doc.captions[active.index + 1]?.start ?? edit.duration)
            : edit.duration
        let from = active.start,
          to = active.end
        if (active.edge === 'start')
          from = Math.max(
            previousEnd,
            Math.min(to - 1 / editor.fps, snapEditTime(from + delta, editor.fps))
          )
        else if (active.edge === 'end')
          to = Math.min(
            nextStart,
            Math.max(from + 1 / editor.fps, snapEditTime(to + delta, editor.fps))
          )
        else {
          from = Math.max(
            previousEnd,
            Math.min(nextStart - (to - from), snapEditTime(from + delta, editor.fps))
          )
          to = from + active.end - active.start
        }
        if (active.kind === 'caption') {
          const caption = doc.captions[active.index]
          caption.start = from
          caption.end = to
          if (caption.words)
            caption.words = caption.words
              .map((word) => ({
                ...word,
                start: word.start + (active.edge ? 0 : from - active.start),
                end: word.end + (active.edge ? 0 : from - active.start)
              }))
              .filter((word) => word.start >= from && word.end <= to)
        } else {
          const region = edit.regions.find((region) => region.id === active.id)
          if (region) {
            region.start = from
            region.duration = to - from
          }
        }
      })
  }
  function finish(event: PointerEvent, cancel = false): void {
    if (!drag) return
    drag = null
    editor.finishGesture(cancel)
    const target = event.currentTarget as HTMLElement
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  }
  function seekStart(event: PointerEvent): void {
    if (event.button !== 0) return
    event.preventDefault()
    scrubbing = true
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    editor.seek(at(event))
  }
  function drop(event: DragEvent, trackId: string): void {
    event.preventDefault()
    event.stopPropagation()
    const assetId = event.dataTransfer?.getData('application/x-cio-video-asset')
    if (assetId) editor.addAsset(assetId, at(event), trackId)
    else if (event.dataTransfer?.files.length)
      void editor.dropFiles(Array.from(event.dataTransfer.files), at(event), trackId)
  }
  function toggleTrack(id: string, key: 'locked' | 'muted' | 'hidden'): void {
    editor.mutate((_doc, edit) => {
      const track = edit.tracks.find((track) => track.id === id)
      if (track) track[key] = !track[key]
    })
  }
</script>

{#snippet bandSizer(id: string, label: string)}
  <StudioSidebarResizeHandle
    sidebarLabel={label}
    axis="y"
    value={trackHeight(id)}
    min={40}
    max={220}
    onResize={(value) => (rowHeights[id] = value)}
    onCommit={rememberRows}
    class="absolute inset-x-0 bottom-0 z-10 h-1.5 w-full cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
  />
{/snippet}

<ContextMenu.Root>
  <ContextMenu.Trigger
    {...stageContext}
    class="flex min-h-0 flex-1 flex-col"
    data-drop-region="video-editor"
    oncontextmenu={(event) => {
      const element = event.target instanceof Element ? event.target : null
      const id = element?.closest<HTMLElement>('[data-video-clip]')?.dataset.videoClip
      contextTrack = element?.closest<HTMLElement>('[data-video-track]')?.dataset.videoTrack ?? ''
      if (id) editor.select({ kind: 'clip', id })
      const caption = element?.closest<HTMLElement>('[data-video-caption]')?.dataset.videoCaption
      const region = element?.closest<HTMLElement>('[data-video-region]')?.dataset.videoRegion
      if (caption !== undefined) editor.select({ kind: 'caption', index: Number(caption) })
      else if (region) editor.select({ kind: 'region', id: region })
    }}
  >
    <div
      class="flex min-h-11 shrink-0 items-center gap-1 border-b border-border bg-surface py-1 text-[0.6875rem] text-muted"
    >
      <span class="shrink-0 px-2" style:width={`${labelWidth + 6}px`}>Tracks</span>
      <div class="flex min-w-0 flex-1 flex-wrap items-center gap-1 pr-2">
        {@render tools?.()}
        <div class="min-w-2 flex-1"></div>
        <button
          type="button"
          class="px-1.5 hover:bg-elevated"
          title="Fit the whole timeline"
          aria-label="Fit the whole timeline"
          onclick={() => void zoomAt(1)}>Fit</button
        >
        <button
          type="button"
          class="px-1.5 hover:bg-elevated disabled:opacity-30"
          title="Zoom out of the timeline"
          aria-label="Zoom out of the timeline"
          disabled={zoom <= 1}
          onclick={() => void zoomAt(zoom / 1.5)}>−</button
        >
        <button
          type="button"
          class="px-1.5 hover:bg-elevated disabled:opacity-30"
          title="Zoom into the timeline"
          aria-label="Zoom into the timeline"
          disabled={contentWidth >= 180000}
          onclick={() => void zoomAt(zoom * 1.5)}>+</button
        >
      </div>
    </div>
    <div class="flex min-h-0 flex-1 overflow-y-auto">
      <div class="shrink-0 border-r border-border bg-surface" style:width={`${labelWidth}px`}>
        <div class="h-6 border-b border-border"></div>
        <div class="h-14 border-b border-border px-2 py-4 text-[0.625rem] text-muted">Frames</div>
        {#each editor.edit?.tracks ?? [] as track (track.id)}
          <div
            class="relative flex items-center gap-1 border-b border-border px-1"
            style:height={`${trackHeight(track.id)}px`}
            data-video-track={track.id}
            role="group"
            aria-label={`${track.name} track controls`}
            draggable="true"
            title={`Drag to reorder ${track.name}`}
            ondragstart={(event) => {
              draggedTrack = track.id
              event.dataTransfer?.setData('application/x-cio-video-track', track.id)
            }}
            ondragover={(event) => {
              if (draggedTrack) event.preventDefault()
            }}
            ondrop={(event) => {
              event.preventDefault()
              event.stopPropagation()
              reorderTrack(draggedTrack, track.id)
              draggedTrack = ''
            }}
            ondragend={() => (draggedTrack = '')}
          >
            <input
              class="min-w-0 flex-1 bg-transparent text-[0.625rem] outline-none focus:bg-elevated"
              value={track.name}
              aria-label="Track name"
              title={`Rename ${track.name}`}
              onchange={(event) =>
                editor.mutate((_doc, edit) => {
                  const target = edit.tracks.find((item) => item.id === track.id)
                  if (target) target.name = event.currentTarget.value
                })}
            />
            {#each [{ key: 'locked', icon: CioLock, label: 'Lock' }, { key: 'hidden', icon: CioEye, label: 'Hide' }, { key: 'muted', icon: CioVolume, label: 'Mute' }] as control (control.key)}
              {@const key = control.key as 'locked' | 'hidden' | 'muted'}
              <button
                type="button"
                class={[
                  'flex h-5 w-5 shrink-0 items-center justify-center hover:bg-elevated',
                  track[key] ? 'text-primary' : 'text-dimmed'
                ]}
                title={`${track[key] ? 'Undo ' : ''}${control.label.toLowerCase()} ${track.name}`}
                aria-label={`${control.label} ${track.name}`}
                aria-pressed={track[key]}
                onclick={() => toggleTrack(track.id, key)}><control.icon size={10} /></button
              >
            {/each}
            <StudioSidebarResizeHandle
              sidebarLabel={`${track.name} track height`}
              axis="y"
              value={trackHeight(track.id)}
              min={40}
              max={220}
              onResize={(value) => (rowHeights[track.id] = value)}
              onCommit={rememberRows}
              class="absolute inset-x-0 bottom-0 z-10 h-1.5 w-full cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
            />
          </div>
        {/each}
        <div
          class="relative flex items-center border-b border-border px-2 text-[0.625rem] text-muted"
          style:height={`${trackHeight('captions')}px`}
        >
          Captions
          {@render bandSizer('captions', 'caption track height')}
        </div>
        <div
          class="relative flex items-center border-b border-border px-2 text-[0.625rem] text-muted"
          style:height={`${trackHeight('regions')}px`}
        >
          Blur / privacy
          {@render bandSizer('regions', 'privacy track height')}
        </div>
        {#if pendingChanges.length}<div
            class="flex h-6 items-center px-2 text-[0.625rem] text-muted"
          >
            Assistant changes
          </div>{/if}
      </div>
      <StudioSidebarResizeHandle
        sidebarLabel="track labels"
        value={labelWidth}
        min={112}
        max={320}
        onResize={(value) => (labelWidth = value)}
        onCommit={rememberRows}
        class="h-full w-1.5 shrink-0 cursor-col-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
      />
      <div
        {@attach (element) => {
          viewport = element
          width = element.clientWidth
          const observer = new ResizeObserver(() => {
            width = element.clientWidth
            queueMicrotask(() => editor.requestFrames(start, end, contentWidth))
          })
          observer.observe(element)
          const offWheel = on(element, 'wheel', wheel, { passive: false })
          const gestureStart = (event: Event): void => {
            event.preventDefault()
            gestureZoom = zoom
          }
          const gestureChange = (event: Event): void => {
            event.preventDefault()
            const gesture = event as Event & { scale: number; clientX: number }
            if (Number.isFinite(gesture.scale))
              void zoomAt(gestureZoom * gesture.scale, gesture.clientX)
          }
          element.addEventListener('gesturestart', gestureStart, { passive: false })
          element.addEventListener('gesturechange', gestureChange, { passive: false })
          return () => {
            observer.disconnect()
            offWheel()
            element.removeEventListener('gesturestart', gestureStart)
            element.removeEventListener('gesturechange', gestureChange)
            if (viewport === element) viewport = undefined
          }
        }}
        class="min-w-0 flex-1 overflow-x-auto"
        onscroll={(event) => {
          scrollLeft = event.currentTarget.scrollLeft
          editor.requestFrames(start, end, contentWidth)
        }}
      >
        <div class="relative min-h-full" style:width={`${contentWidth}px`}>
          <div
            class="relative h-6 cursor-ew-resize touch-none border-b border-border bg-surface"
            role="slider"
            tabindex="0"
            aria-label="Timeline playhead"
            title="Drag to seek precisely"
            aria-valuemin="0"
            aria-valuemax={editor.duration}
            aria-valuenow={editor.time}
            onpointerdown={seekStart}
            onpointermove={(event) => {
              hoverTime = Math.max(0, Math.min(editor.duration, at(event)))
              if (scrubbing) editor.seek(at(event))
            }}
            onpointerleave={() => {
              if (!scrubbing) hoverTime = null
            }}
            onpointerup={() => (scrubbing = false)}
            onpointercancel={() => (scrubbing = false)}
            onkeydown={(event) => {
              if (keymapState.matches('video-edit-frame-back', event)) {
                event.preventDefault()
                editor.seek(editor.time - 1 / editor.fps)
              } else if (keymapState.matches('video-edit-frame-forward', event)) {
                event.preventDefault()
                editor.seek(editor.time + 1 / editor.fps)
              }
            }}
          >
            {#each ticks as tick (tick)}<span
                class="pointer-events-none absolute top-0 border-l border-border pl-1 font-mono text-[0.5625rem] leading-6 text-dimmed"
                style:left={`${tick * scale}px`}>{videoTimecode(tick)}</span
              >{/each}
            {#if hoverTime !== null}<span
                class="pointer-events-none absolute top-0 z-10 border-l border-primary bg-elevated px-1 font-mono text-[0.625rem] leading-6 text-foreground"
                style:left={`${hoverTime * scale}px`}
                >{videoTimecode(hoverTime)} · f{Math.round(hoverTime * editor.fps)}</span
              >{/if}
          </div>
          <div
            class="relative h-14 overflow-hidden border-b border-border bg-app"
            aria-label="Video frame thumbnails"
          >
            {#each frameCells as cell (cell.frame)}
              {@const frame = editor.frames.get(cell.time)}
              {#if frame}<img
                  src={frame.image}
                  alt={`Video at ${videoTimecode(frame.time)}`}
                  class="pointer-events-none absolute top-0 h-14 object-cover"
                  style:left={`${cell.time * scale}px`}
                  style:width={`${Math.max(1, (cell.end - cell.time) * scale)}px`}
                  draggable="false"
                />{/if}
            {/each}
          </div>
          {#each editor.edit?.tracks ?? [] as track (track.id)}
            <div
              class="relative border-b border-border bg-app"
              style:height={`${trackHeight(track.id)}px`}
              data-video-track={track.id}
              role="group"
              aria-label={`${track.name} track`}
              ondragover={(event) => {
                event.preventDefault()
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
              }}
              ondrop={(event) => drop(event, track.id)}
            >
              {#each visibleClips.filter((clip) => clip.trackId === track.id) as clip (clip.id)}
                {@const asset = editor.edit?.assets.find((asset) => asset.id === clip.assetId)}
                <button
                  type="button"
                  class={[
                    'absolute top-1 flex min-w-1 touch-none items-center overflow-hidden border px-2 text-left text-[0.625rem]',
                    editor.selection?.kind === 'clip' && editor.selection.id === clip.id
                      ? 'border-primary bg-primary/25 text-foreground ring-2 ring-primary ring-inset'
                      : track.kind === 'audio'
                        ? 'border-success/35 bg-success/10 text-foreground'
                        : 'border-border bg-elevated text-foreground',
                    track.locked
                      ? 'cursor-not-allowed opacity-50'
                      : 'cursor-grab active:cursor-grabbing'
                  ]}
                  style:left={`${clip.start * scale}px`}
                  style:width={`${Math.max(4, clip.duration * scale)}px`}
                  style:height={`${trackHeight(track.id) - 12}px`}
                  data-video-clip={clip.id}
                  aria-pressed={editor.selection?.kind === 'clip' &&
                    editor.selection.id === clip.id}
                  title={`${asset?.name ?? 'Clip'} · ${videoTimecode(clip.start)} · drag to move; drag an edge to trim`}
                  aria-label={`${asset?.name ?? 'Clip'} at ${videoTimecode(clip.start)}`}
                  onpointerdown={(event) => startClip(event, clip.id)}
                  onpointermove={move}
                  onpointerup={finish}
                  onpointercancel={(event) => finish(event, true)}
                  onclick={() => editor.select({ kind: 'clip', id: clip.id })}
                  ondblclick={(event) => {
                    editor.seek(at(event))
                    editor.split()
                  }}
                >
                  <span
                    class="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-border/50"
                    data-trim="start"
                  ></span>
                  {#if editor.waveforms[editor.waveformKey(clip)]}
                    <img
                      class="pointer-events-none absolute inset-0 h-full w-full opacity-35"
                      src={editor.waveforms[editor.waveformKey(clip)] ?? undefined}
                      alt=""
                      draggable="false"
                    />
                  {/if}
                  <span class="pointer-events-none relative truncate">{asset?.name ?? 'Clip'}</span>
                  <span
                    class="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-border/50"
                    data-trim="end"
                  ></span>
                </button>
              {/each}
              <StudioSidebarResizeHandle
                sidebarLabel={`${track.name} track height`}
                axis="y"
                value={trackHeight(track.id)}
                min={40}
                max={220}
                onResize={(value) => (rowHeights[track.id] = value)}
                onCommit={rememberRows}
                class="absolute inset-x-0 bottom-0 z-10 h-1.5 w-full cursor-row-resize touch-none bg-transparent hover:bg-primary/30 focus:bg-primary/30 focus:outline-none"
              />
            </div>
          {/each}
          <div
            class="relative border-b border-border"
            style:height={`${trackHeight('captions')}px`}
            role="group"
            aria-label="Caption timing"
          >
            {#each visibleCaptions as { caption, index } (index)}
              {#if caption.end >= start && caption.start <= end}
                <button
                  type="button"
                  class={[
                    'absolute top-1 touch-none overflow-hidden border px-2 text-left text-[0.5625rem]',
                    editor.selection?.kind === 'caption' && editor.selection.index === index
                      ? 'border-primary bg-primary/25 text-foreground ring-2 ring-primary ring-inset'
                      : 'border-warning/30 bg-warning/10 text-foreground'
                  ]}
                  style:left={`${caption.start * scale}px`}
                  style:width={`${Math.max(4, (caption.end - caption.start) * scale)}px`}
                  title={`${caption.text} · drag to move or trim`}
                  aria-label={`Caption: ${caption.text}`}
                  data-video-caption={index}
                  aria-pressed={editor.selection?.kind === 'caption' &&
                    editor.selection.index === index}
                  style:height={`${trackHeight('captions') - 12}px`}
                  onpointerdown={(event) =>
                    startBand(event, 'caption', '', index, caption.start, caption.end)}
                  onpointermove={move}
                  onpointerup={finish}
                  onpointercancel={(event) => finish(event, true)}
                  onclick={() => editor.select({ kind: 'caption', index }, caption.start)}
                >
                  <span
                    class="absolute inset-y-0 left-0 w-1 cursor-ew-resize bg-warning/30"
                    data-trim="start"
                  ></span><span class="pointer-events-none whitespace-nowrap">{caption.text}</span
                  ><span
                    class="absolute inset-y-0 right-0 w-1 cursor-ew-resize bg-warning/30"
                    data-trim="end"
                  ></span>
                </button>
              {/if}
            {/each}
            {@render bandSizer('captions', 'caption track height')}
          </div>
          <div
            class="relative border-b border-border"
            style:height={`${trackHeight('regions')}px`}
            role="group"
            aria-label="Blur and privacy regions"
          >
            {#each editor.edit?.regions ?? [] as region (region.id)}
              {#if region.start + region.duration >= start && region.start <= end}
                <button
                  type="button"
                  class={[
                    'absolute top-1 touch-none overflow-hidden border px-2 text-left text-[0.5625rem]',
                    editor.selection?.kind === 'region' && editor.selection.id === region.id
                      ? 'border-primary bg-primary/25 text-foreground ring-2 ring-primary ring-inset'
                      : 'border-danger/30 bg-danger/10 text-foreground'
                  ]}
                  style:left={`${region.start * scale}px`}
                  style:width={`${Math.max(4, region.duration * scale)}px`}
                  title={`${region.kind} · drag to move or trim`}
                  aria-label={`${region.kind} region at ${videoTimecode(region.start)}`}
                  data-video-region={region.id}
                  aria-pressed={editor.selection?.kind === 'region' &&
                    editor.selection.id === region.id}
                  style:height={`${trackHeight('regions') - 12}px`}
                  onpointerdown={(event) =>
                    startBand(
                      event,
                      'region',
                      region.id,
                      -1,
                      region.start,
                      region.start + region.duration
                    )}
                  onpointermove={move}
                  onpointerup={finish}
                  onpointercancel={(event) => finish(event, true)}
                  onclick={() => editor.select({ kind: 'region', id: region.id }, region.start)}
                >
                  <span
                    class="absolute inset-y-0 left-0 w-1 cursor-ew-resize bg-danger/30"
                    data-trim="start"
                  ></span><span class="pointer-events-none">{region.kind}</span><span
                    class="absolute inset-y-0 right-0 w-1 cursor-ew-resize bg-danger/30"
                    data-trim="end"
                  ></span>
                </button>
              {/if}
            {/each}
            {@render bandSizer('regions', 'privacy track height')}
          </div>
          {#if pendingChanges.length}<div
              class="relative h-6"
              role="group"
              aria-label="Unreviewed assistant changes"
            >
              {#each pendingChanges as change (change.id)}
                <button
                  type="button"
                  class="absolute top-1 h-4 overflow-hidden bg-primary/30 px-1 text-[0.5625rem] text-primary"
                  style:left={`${change.start * scale}px`}
                  style:width={`${Math.max(10, (change.end - change.start) * scale)}px`}
                  title={`${change.label} · click to review from here`}
                  aria-label={change.label}
                  onclick={() => editor.seek(change.start)}>Agent</button
                >
              {/each}
            </div>{/if}
          <div
            class="pointer-events-none absolute inset-y-0 z-10 w-px bg-primary"
            style:left={`${editor.time * scale}px`}
          ></div>
        </div>
      </div>
    </div>
  </ContextMenu.Trigger>
  <ContextMenu.Portal>
    <ContextMenu.Content
      data-layer-above-modal
      {...occlusion}
      class="z-80 flex min-w-56 flex-col border border-border bg-surface py-1 shadow-lg"
    >
      {@render contextActions?.()}
      {#if contextTrack}
        <ContextMenu.Separator class="my-1 h-px bg-border" />
        <ContextMenu.Item
          class="cursor-pointer px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated"
          onSelect={() => editor.duplicateTrack(contextTrack)}>Duplicate track</ContextMenu.Item
        >
        <ContextMenu.Item
          class="cursor-pointer px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated"
          onSelect={() => shiftTrack(-1)}>Move track up</ContextMenu.Item
        >
        <ContextMenu.Item
          class="cursor-pointer px-3 py-1.5 text-xs outline-none data-highlighted:bg-elevated"
          onSelect={() => shiftTrack(1)}>Move track down</ContextMenu.Item
        >
      {/if}
    </ContextMenu.Content>
  </ContextMenu.Portal>
</ContextMenu.Root>
