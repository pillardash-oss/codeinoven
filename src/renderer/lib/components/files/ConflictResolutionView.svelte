<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    ArrowLeftToLine,
    ArrowRightToLine,
    Check,
    FileWarning,
    GitMerge,
    Loader2,
    Redo2,
    Undo2,
    WrapText
  } from '@lucide/svelte'
  import type { GitConflictWorkFile, GitConflictWorkHunkState } from '$shared/types'
  import {
    createFileEditor,
    type FileEditorConflictRange,
    type FileEditorController,
    type FileEditorDocumentChange
  } from '$lib/editor/codemirror-file-editor'
  import { gitState } from '$lib/stores/git.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import type {
    ConflictResolutionController,
    ConflictResolutionStatus
  } from './conflict-resolution'

  interface ConnectorGeometry {
    incoming: string
    current: string
  }

  interface Props {
    projectId: string
    path: string
    wrap?: boolean
    onToggleWrap?: () => void
    onControllerChange?: (controller: ConflictResolutionController | null) => void
    onStatusChange?: (status: ConflictResolutionStatus) => void
  }

  let {
    projectId,
    path,
    wrap = false,
    onToggleWrap = () => {},
    onControllerChange = () => {},
    onStatusChange = () => {}
  }: Props = $props()

  let workFile = $state<GitConflictWorkFile | null>(null)
  let scratchContent = $state('')
  let hunkStates = $state<GitConflictWorkHunkState[]>([])
  let activeHunk = $state(0)
  let loading = $state(false)
  let saving = $state(false)
  let dirty = $state(false)
  let error = $state<string | null>(null)
  let mergeRoot = $state<HTMLDivElement | null>(null)
  let incomingPane = $state<HTMLElement | null>(null)
  let centerHost = $state<HTMLDivElement | null>(null)
  let currentPane = $state<HTMLElement | null>(null)
  let incomingHost = $state<HTMLDivElement | null>(null)
  let currentHost = $state<HTMLDivElement | null>(null)
  let centerController = $state<FileEditorController | null>(null)
  let incomingController = $state<FileEditorController | null>(null)
  let currentController = $state<FileEditorController | null>(null)
  let connectorGeometry = $state<ConnectorGeometry | null>(null)
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let connectorFrame: number | null = null

  const analysis = $derived(workFile?.analysis ?? null)
  const activeHunkData = $derived(analysis?.hunks[activeHunk] ?? null)
  const activeState = $derived(hunkStates[activeHunk] ?? null)
  const resolvedCount = $derived(hunkStates.filter(isResolved).length)
  const allResolved = $derived(hunkStates.length > 0 && resolvedCount === hunkStates.length)

  function isResolved(state: GitConflictWorkHunkState): boolean {
    return state.acceptedIncoming || state.acceptedCurrent || state.edited
  }

  function editorRanges(states = hunkStates): FileEditorConflictRange[] {
    return states.map((state) => ({
      id: String(state.index),
      from: state.from,
      to: state.to,
      resolved: isResolved(state),
      active: state.index === activeHunk
    }))
  }

  function notifyStatus(): void {
    onStatusChange({ canSave: allResolved, dirty, saving })
  }

  async function persistScratch(): Promise<void> {
    if (!workFile) return
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    await gitState.writeConflictWorkFile(projectId, path, scratchContent, hunkStates)
  }

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer)
    persistTimer = setTimeout(() => {
      persistTimer = null
      void persistScratch()
    }, 220)
  }

  function syncRangesFromEditor(): void {
    const ranges = centerController?.getConflictRanges()
    if (!ranges) return
    hunkStates = hunkStates.map((state) => {
      const range = ranges.find((candidate) => candidate.id === String(state.index))
      return range ? { ...state, from: range.from, to: range.to } : state
    })
  }

  function intersects(change: FileEditorDocumentChange, state: GitConflictWorkHunkState): boolean {
    return change.from <= state.to && change.to >= state.from
  }

  function handleCenterChange(
    text: string,
    changes: FileEditorDocumentChange[],
    userEvent: string | null
  ): void {
    const before = hunkStates.map((state) => ({ ...state }))
    scratchContent = text
    syncRangesFromEditor()
    if (userEvent?.startsWith('input') || userEvent === 'undo' || userEvent === 'redo') {
      hunkStates = hunkStates.map((state, index) =>
        changes.some((change) => intersects(change, before[index] ?? state))
          ? {
              ...state,
              acceptedIncoming:
                userEvent === 'undo' || userEvent === 'redo' ? false : state.acceptedIncoming,
              acceptedCurrent:
                userEvent === 'undo' || userEvent === 'redo' ? false : state.acceptedCurrent,
              edited: true
            }
          : state
      )
      centerController?.setConflictRanges(editorRanges())
    }
    dirty = true
    notifyStatus()
    schedulePersist()
    scheduleConnectors()
  }

  function replaceActiveRange(text: string, nextState: GitConflictWorkHunkState): void {
    const controller = centerController
    const range = controller
      ?.getConflictRanges()
      .find((candidate) => candidate.id === String(nextState.index))
    if (!controller || !range) return
    controller.replaceRange(range.from, range.to, text, 'merge.accept')
    const mapped = controller.getConflictRanges()
    const next = hunkStates.map((state) => {
      const mappedRange = mapped.find((candidate) => candidate.id === String(state.index))
      if (state.index === nextState.index) {
        return { ...nextState, from: range.from, to: range.from + text.length }
      }
      return mappedRange ? { ...state, from: mappedRange.from, to: mappedRange.to } : state
    })
    hunkStates = next
    controller.setConflictRanges(editorRanges(next))
    scratchContent = controller.getValue()
    dirty = true
    notifyStatus()
    schedulePersist()
    scheduleConnectors()
  }

  function acceptSide(side: 'incoming' | 'current'): void {
    const hunk = activeHunkData
    const state = activeState
    const controller = centerController
    if (!hunk || !state || !controller) return
    if (side === 'incoming' && state.acceptedIncoming) return
    if (side === 'current' && state.acceptedCurrent) return
    const existing = controller.getValue().slice(state.from, state.to)
    const acceptedOther = side === 'incoming' ? state.acceptedCurrent : state.acceptedIncoming
    const block = side === 'incoming' ? hunk.theirs : hunk.ours
    const text = acceptedOther && existing.trim() ? `${existing}\n\n${block}` : block
    replaceActiveRange(text, {
      ...state,
      acceptedIncoming: state.acceptedIncoming || side === 'incoming',
      acceptedCurrent: state.acceptedCurrent || side === 'current',
      edited: false
    })
  }

  function mergeBoth(): void {
    const hunk = activeHunkData
    const state = activeState
    if (!hunk || !state || (state.acceptedIncoming && state.acceptedCurrent)) return
    replaceActiveRange([hunk.theirs, hunk.ours].filter(Boolean).join('\n\n'), {
      ...state,
      acceptedIncoming: true,
      acceptedCurrent: true,
      edited: false
    })
  }

  function acceptAll(side: 'incoming' | 'current'): void {
    const currentAnalysis = analysis
    const controller = centerController
    if (!currentAnalysis || !controller) return
    let next = hunkStates.map((state) => ({ ...state }))
    for (let index = 0; index < currentAnalysis.hunks.length; index += 1) {
      const hunk = currentAnalysis.hunks[index]
      const state = next[index]
      if (!hunk || !state) continue
      if (side === 'incoming' && state.acceptedIncoming) continue
      if (side === 'current' && state.acceptedCurrent) continue
      const range = controller
        .getConflictRanges()
        .find((candidate) => candidate.id === String(state.index))
      if (!range) continue
      const existing = controller.getValue().slice(range.from, range.to)
      const acceptedOther = side === 'incoming' ? state.acceptedCurrent : state.acceptedIncoming
      const block = side === 'incoming' ? hunk.theirs : hunk.ours
      const text = acceptedOther && existing.trim() ? `${existing}\n\n${block}` : block
      controller.replaceRange(range.from, range.to, text, 'merge.accept-all')
      const mapped = controller.getConflictRanges()
      next = next.map((candidate) => {
        const mappedRange = mapped.find((item) => item.id === String(candidate.index))
        if (candidate.index === state.index) {
          return {
            ...candidate,
            from: range.from,
            to: range.from + text.length,
            acceptedIncoming: candidate.acceptedIncoming || side === 'incoming',
            acceptedCurrent: candidate.acceptedCurrent || side === 'current',
            edited: false
          }
        }
        return mappedRange
          ? { ...candidate, from: mappedRange.from, to: mappedRange.to }
          : candidate
      })
      controller.setConflictRanges(editorRanges(next))
    }
    hunkStates = next
    scratchContent = controller.getValue()
    dirty = true
    notifyStatus()
    schedulePersist()
    scheduleConnectors()
  }

  function selectHunk(index: number): void {
    if (index < 0 || index >= hunkStates.length) return
    activeHunk = index
    const controller = centerController
    controller?.setConflictRanges(editorRanges())
    const state = hunkStates[index]
    if (!state || !controller) return
    requestAnimationFrame(() => {
      controller.scrollToConflictRange(String(state.index))
      scheduleConnectors()
    })
  }

  function undo(): void {
    if (!centerController?.undo()) return
    dirty = true
    notifyStatus()
    schedulePersist()
  }

  function redo(): void {
    if (!centerController?.redo()) return
    dirty = true
    notifyStatus()
    schedulePersist()
  }

  async function save(): Promise<boolean> {
    if (!allResolved || saving) return false
    saving = true
    notifyStatus()
    try {
      await persistScratch()
      const saved = await gitState.saveConflictResolution(projectId, path, scratchContent)
      if (!saved) return false
      dirty = false
      await projectFilesWorkspace.reload(projectId, path)
      return true
    } finally {
      saving = false
      notifyStatus()
    }
  }

  const controller: ConflictResolutionController = { save }

  onMount(() => {
    onControllerChange(controller)
    return () => {
      if (persistTimer) clearTimeout(persistTimer)
      if (connectorFrame !== null) cancelAnimationFrame(connectorFrame)
      onControllerChange(null)
    }
  })

  $effect(() => {
    let cancelled = false
    loading = true
    error = null
    workFile = null
    void gitState
      .prepareConflictWorkFile(projectId, path)
      .then((prepared) => {
        if (cancelled) return
        workFile = prepared
        scratchContent = prepared.content
        hunkStates = prepared.hunks.map((state) => ({ ...state }))
        activeHunk = 0
        dirty = false
        notifyStatus()
      })
      .catch((reason) => {
        if (cancelled) return
        error = reason instanceof Error ? reason.message : 'The conflict could not be prepared'
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    const prepared = workFile
    const host = centerHost
    if (!prepared || !host) return
    let cancelled = false
    let mounted: FileEditorController | null = null
    void createFileEditor({
      host,
      value: prepared.content,
      path,
      wrap,
      showLineNumbers: true,
      ariaLabel: `Conflict scratch document for ${path}`,
      conflictRanges: editorRanges(prepared.hunks),
      onDocChange: handleCenterChange,
      onScroll: scheduleConnectors
    }).then((editor) => {
      if (cancelled) {
        editor.destroy()
        return
      }
      mounted = editor
      centerController = editor
      const first = prepared.hunks[0]
      if (first) editor.scrollToConflictRange(String(first.index))
      scheduleConnectors()
    })
    return () => {
      cancelled = true
      mounted?.destroy()
      if (centerController === mounted) centerController = null
    }
  })

  $effect(() => {
    centerController?.setWrap(wrap)
    incomingController?.setWrap(wrap)
    currentController?.setWrap(wrap)
  })

  $effect(() => {
    const root = mergeRoot
    if (!root) return
    const observer = new ResizeObserver(scheduleConnectors)
    observer.observe(root)
    return () => observer.disconnect()
  })

  $effect(() => {
    const hunk = activeHunkData
    const incoming = incomingHost
    const current = currentHost
    if (!hunk || !incoming || !current) return
    let cancelled = false
    let mountedIncoming: FileEditorController | null = null
    let mountedCurrent: FileEditorController | null = null
    void Promise.all([
      createSideEditor(incoming, hunk.theirs, `Incoming block for ${path}`),
      createSideEditor(current, hunk.ours, `Current block for ${path}`)
    ]).then(([incomingEditor, currentEditor]) => {
      if (cancelled) {
        incomingEditor.destroy()
        currentEditor.destroy()
        return
      }
      mountedIncoming = incomingEditor
      mountedCurrent = currentEditor
      incomingController = incomingEditor
      currentController = currentEditor
      scheduleConnectors()
    })
    return () => {
      cancelled = true
      mountedIncoming?.destroy()
      mountedCurrent?.destroy()
      if (incomingController === mountedIncoming) incomingController = null
      if (currentController === mountedCurrent) currentController = null
    }
  })

  function createSideEditor(
    host: HTMLDivElement,
    value: string,
    ariaLabel: string
  ): Promise<FileEditorController> {
    return createFileEditor({
      host,
      value,
      path,
      readonly: true,
      wrap,
      showLineNumbers: true,
      ariaLabel,
      onDocChange: () => {},
      onScroll: scheduleConnectors
    })
  }

  function scheduleConnectors(): void {
    if (connectorFrame !== null) cancelAnimationFrame(connectorFrame)
    connectorFrame = requestAnimationFrame(() => {
      connectorFrame = null
      updateConnectorGeometry()
    })
  }

  function updateConnectorGeometry(): void {
    const root = mergeRoot
    const incoming = incomingPane
    const current = currentPane
    const center = centerHost
    const state = activeState
    const editor = centerController
    if (!root || !incoming || !current || !center || !state || !editor) {
      connectorGeometry = null
      return
    }
    const target = editor.getRangeViewportRect(String(state.index))
    if (!target) {
      connectorGeometry = null
      return
    }
    const rootRect = root.getBoundingClientRect()
    const incomingRect = incoming.getBoundingClientRect()
    const currentRect = current.getBoundingClientRect()
    const centerRect = center.getBoundingClientRect()
    const targetY = centerRect.top - rootRect.top + (target.top + target.bottom) / 2
    connectorGeometry = {
      incoming: `M ${incomingRect.right - rootRect.left} ${incomingRect.top - rootRect.top + 38} L ${centerRect.left - rootRect.left} ${targetY}`,
      current: `M ${centerRect.right - rootRect.left} ${targetY} L ${currentRect.left - rootRect.left} ${currentRect.top - rootRect.top + 38}`
    }
  }
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  {#if loading && !workFile}
    <div class="flex flex-1 items-center justify-center gap-2 text-xs text-dimmed">
      <Loader2 size={14} class="animate-spin" /> Preparing conflict scratch document
    </div>
  {:else if error}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <FileWarning size={22} class="text-danger" />
      <p class="text-xs font-medium text-foreground">Could not prepare this conflict</p>
      <p class="max-w-[48ch] text-[10px] leading-relaxed text-danger">{error}</p>
    </div>
  {:else if !analysis}
    <div class="flex flex-1 items-center justify-center text-xs text-dimmed">
      No conflict analysis is available.
    </div>
  {:else if analysis.binary || analysis.truncated}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
      <AlertTriangle size={22} class="text-warning" />
      <p class="text-xs font-medium text-foreground">
        {analysis.binary ? 'Binary conflict' : 'File too large for the merge editor'}
      </p>
    </div>
  {:else}
    <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
      <GitMerge size={13} class="text-warning" />
      <span class="text-[10px] font-semibold text-foreground"
        >Conflict {activeHunk + 1} of {analysis.hunks.length}</span
      >
      <span class="font-mono text-[9px] tabular-nums text-dimmed"
        >{resolvedCount}/{analysis.hunks.length} resolved</span
      >
      <button
        type="button"
        class="ml-1 h-6 rounded border border-accent/40 px-2 text-[9px] font-medium text-accent hover:bg-accent/10"
        title="Accept every incoming conflict block"
        onclick={() => acceptAll('incoming')}>Accept all incoming</button
      >
      <button
        type="button"
        class="h-6 rounded border border-primary/40 px-2 text-[9px] font-medium text-primary hover:bg-primary/10"
        title="Accept every current conflict block"
        onclick={() => acceptAll('current')}>Accept all current</button
      >
      <button
        type="button"
        class={[
          'flex h-6 items-center gap-1 rounded px-2 text-[9px] font-medium transition-colors',
          wrap ? 'bg-overlay text-foreground' : 'text-muted hover:bg-elevated hover:text-foreground'
        ]}
        aria-pressed={wrap}
        title={wrap ? 'Disable line wrapping' : 'Enable line wrapping'}
        onclick={onToggleWrap}><WrapText size={11} />Wrap</button
      >
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-elevated hover:text-foreground"
        title="Undo conflict edit"
        aria-label="Undo conflict edit"
        onclick={undo}><Undo2 size={12} /></button
      >
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-elevated hover:text-foreground"
        title="Redo conflict edit"
        aria-label="Redo conflict edit"
        onclick={redo}><Redo2 size={12} /></button
      >
    </div>

    <div class="flex h-8 shrink-0 items-center gap-1 border-b border-border bg-elevated/30 px-2">
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed hover:bg-elevated hover:text-foreground disabled:opacity-30"
        title="Previous conflict"
        aria-label="Previous conflict"
        disabled={activeHunk === 0}
        onclick={() => selectHunk(activeHunk - 1)}><ArrowLeftToLine size={12} /></button
      >
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {#each hunkStates as state (state.index)}
          <button
            type="button"
            class={[
              'flex h-6 shrink-0 items-center gap-1 rounded px-2 font-mono text-[9px] tabular-nums',
              state.index === activeHunk
                ? 'bg-primary/15 text-primary'
                : isResolved(state)
                  ? 'bg-success/10 text-success'
                  : 'text-dimmed hover:bg-elevated hover:text-foreground'
            ]}
            title={`Conflict ${state.index + 1}`}
            onclick={() => selectHunk(state.index)}
          >
            {#if isResolved(state)}<Check size={9} />{/if}{state.index + 1}
          </button>
        {/each}
      </div>
      <button
        type="button"
        class="flex h-6 w-6 items-center justify-center rounded text-dimmed hover:bg-elevated hover:text-foreground disabled:opacity-30"
        title="Next conflict"
        aria-label="Next conflict"
        disabled={activeHunk >= hunkStates.length - 1}
        onclick={() => selectHunk(activeHunk + 1)}><ArrowRightToLine size={12} /></button
      >
    </div>

    {#if activeHunkData && activeState}
      <div
        bind:this={mergeRoot}
        class="relative grid min-h-0 flex-1 grid-cols-[1fr_1.35fr_1fr] gap-3 p-3"
      >
        <svg
          class="pointer-events-none absolute inset-0 z-10 h-full w-full overflow-visible"
          aria-hidden="true"
        >
          {#if connectorGeometry}
            <path
              d={connectorGeometry.incoming}
              fill="none"
              stroke="var(--color-accent)"
              stroke-width="2"
            />
            <path
              d={connectorGeometry.current}
              fill="none"
              stroke="var(--color-primary)"
              stroke-width="2"
            />
          {/if}
        </svg>

        <section
          bind:this={incomingPane}
          class="relative z-20 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-accent/40 bg-app"
        >
          <div
            class="flex h-9 shrink-0 items-center gap-2 border-b border-accent/30 bg-accent/10 px-2"
          >
            <span class="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold text-accent"
              >incoming</span
            >
            <span class="min-w-0 flex-1 truncate font-mono text-[9px] text-dimmed"
              >{activeHunkData.theirsLabel}</span
            >
            <button
              type="button"
              class="h-6 shrink-0 rounded bg-accent px-2 text-[9px] font-semibold text-on-primary disabled:opacity-40"
              disabled={activeState.acceptedIncoming}
              title="Accept this incoming block"
              onclick={() => acceptSide('incoming')}>Accept incoming</button
            >
          </div>
          <div bind:this={incomingHost} class="min-h-0 flex-1 overflow-auto"></div>
        </section>

        <section
          class="relative z-20 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-app"
        >
          <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-2">
            <span
              class={[
                'rounded px-1.5 py-0.5 text-[9px] font-semibold',
                isResolved(activeState)
                  ? 'bg-success/15 text-success'
                  : 'bg-warning/15 text-warning'
              ]}>scratch</span
            >
            <span class="min-w-0 flex-1 truncate font-mono text-[9px] text-dimmed"
              >{workFile?.scratchPath}</span
            >
            <button
              type="button"
              class="h-6 shrink-0 rounded border border-border px-2 text-[9px] font-semibold text-foreground hover:bg-elevated disabled:opacity-40"
              disabled={activeState.acceptedIncoming && activeState.acceptedCurrent}
              title="Merge incoming above current"
              onclick={mergeBoth}>Merge both</button
            >
          </div>
          <div bind:this={centerHost} class="min-h-0 flex-1 overflow-auto"></div>
        </section>

        <section
          bind:this={currentPane}
          class="relative z-20 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-primary/40 bg-app"
        >
          <div
            class="flex h-9 shrink-0 items-center gap-2 border-b border-primary/30 bg-primary/10 px-2"
          >
            <span class="rounded bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold text-primary"
              >current</span
            >
            <span class="min-w-0 flex-1 truncate font-mono text-[9px] text-dimmed"
              >{activeHunkData.oursLabel}</span
            >
            <button
              type="button"
              class="h-6 shrink-0 rounded bg-primary px-2 text-[9px] font-semibold text-on-primary disabled:opacity-40"
              disabled={activeState.acceptedCurrent}
              title="Accept this current block"
              onclick={() => acceptSide('current')}>Accept current</button
            >
          </div>
          <div bind:this={currentHost} class="min-h-0 flex-1 overflow-auto"></div>
        </section>
      </div>
    {/if}
  {/if}
</div>
