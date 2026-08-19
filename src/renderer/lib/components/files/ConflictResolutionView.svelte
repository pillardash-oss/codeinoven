<script lang="ts">
  import { untrack } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    AlertTriangle,
    ArrowLeftToLine,
    ArrowRightToLine,
    Check,
    FileWarning,
    GitMerge,
    Loader2,
    Redo2,
    Undo2
  } from '@lucide/svelte'
  import type { GitConflictAnalysis } from '$shared/types'
  import { gitState } from '$lib/stores/git.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { createFileEditor, type FileEditorController } from '$lib/editor/codemirror-file-editor'

  interface Props {
    projectId: string
    /** The conflicted file being resolved. */
    path: string
  }

  let { projectId, path }: Props = $props()

  let analysis = $state<GitConflictAnalysis | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  /** Per-hunk resolution text; null means that hunk is not decided yet. */
  let resolutions = $state<(string | null)[]>([])
  /** The hunk currently shown in the merge editor. */
  let activeHunk = $state(0)
  /** Context lines shown above/below the focused conflict — only in the middle. */
  let contextAbove = $state(3)
  let contextBelow = $state(3)
  /** Undo/redo stacks of the resolutions array. */
  let past = $state<(string | null)[][]>([])
  let future = $state<(string | null)[][]>([])

  $effect(() => {
    let cancelled = false
    loading = true
    error = null
    analysis = null
    resolutions = []
    activeHunk = 0
    past = []
    future = []
    void invoke('git:analyzeConflict', projectId, path)
      .then((next) => {
        if (cancelled) return
        analysis = next
        resolutions = next.hunks.map(() => null)
      })
      .catch((reason) => {
        if (cancelled) return
        error = reason instanceof Error ? reason.message : 'The conflict could not be analyzed'
      })
      .finally(() => {
        if (!cancelled) loading = false
      })
    return () => {
      cancelled = true
    }
  })

  const resolvedCount = $derived(
    resolutions.filter((resolution) => typeof resolution === 'string').length
  )

  function commit(next: (string | null)[]): void {
    past = [...past, [...resolutions]]
    future = []
    resolutions = next
    syncToFile(next)
  }

  function resolveHunk(index: number, resolution: string): void {
    if (resolutions[index] === resolution) return
    const next = [...resolutions]
    next[index] = resolution
    commit(next)
  }

  function clearHunk(index: number): void {
    if (resolutions[index] === null) return
    const next = [...resolutions]
    next[index] = null
    commit(next)
  }

  function acceptAll(side: 'incoming' | 'current'): void {
    const current = analysis
    if (!current) return
    const next = current.hunks.map((hunk) => (side === 'incoming' ? hunk.theirs : hunk.ours))
    commit(next)
  }

  function mergeBoth(index: number): void {
    const hunk = analysis?.hunks[index]
    if (!hunk) return
    resolveHunk(index, [hunk.ours, hunk.theirs].filter((side) => side.trim() !== '').join('\n\n'))
  }

  function undo(): void {
    const previous = past.at(-1)
    if (previous === undefined) return
    past = past.slice(0, -1)
    future = [...future, [...resolutions]]
    resolutions = previous
    syncToFile(previous)
  }

  function redo(): void {
    const next = future.at(-1)
    if (next === undefined) return
    future = future.slice(0, -1)
    past = [...past, [...resolutions]]
    resolutions = next
    syncToFile(next)
  }

  function assembleContentFor(list: (string | null)[]): string {
    const current = analysis
    if (!current) return ''
    const lines = current.content.split('\n')
    const hunks = current.hunks
    for (let index = hunks.length - 1; index >= 0; index -= 1) {
      const hunk = hunks[index]
      const resolution = list[index]
      if (!hunk || !hunk.startLine || !hunk.endLine) continue
      if (typeof resolution !== 'string') continue
      lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...resolution.split('\n'))
    }
    return lines.join('\n')
  }

  /**
   * Keep the working state consistent as the user resolves:
   * - mirror the assembled file into the file session's draft so the top toolbar
   *   Save persists it and git clears the unmerged entry, and
   * - write it to the scratch file (`.cio/git/merge-conflict/<branch>/<path>`).
   */
  function syncToFile(list: (string | null)[]): void {
    const content = assembleContentFor(list)
    try {
      projectFilesWorkspace.updateDraft(projectId, path, content)
    } catch {
      // No open session tab yet — the draft will settle on the next update.
    }
    void gitState.writeConflictWorkFile(projectId, path, content)
  }

  async function openInEditor(): Promise<void> {
    try {
      await projectFilesWorkspace.openFile(projectId, path)
    } catch {
      // Editor open failed — nothing else to do.
    }
  }

  // ─── Merge editor (IntelliJ-style windowing) ─────────────────────────────

  let theirsHost = $state<HTMLDivElement | null>(null)
  let resultHost = $state<HTMLDivElement | null>(null)
  let oursHost = $state<HTMLDivElement | null>(null)
  let resultController = $state<FileEditorController | null>(null)
  /** Last resolution text the mounted result editor reflects. */
  let resultEditorText = $state<string | null>(null)

  const activeHunkData = $derived(analysis?.hunks[activeHunk] ?? null)
  const fileLines = $derived(analysis?.content.split('\n') ?? [])

  /** Context window above/below the focused hunk (real file lines). */
  const contextWindow = $derived.by(() => {
    const hunk = activeHunkData
    if (!hunk) return { above: [] as string[], below: [] as string[] }
    const aboveStart = Math.max(1, hunk.startLine - contextAbove)
    const above: string[] = []
    for (let line = aboveStart; line < hunk.startLine; line += 1) {
      above.push(fileLines[line - 1] ?? '')
    }
    const below: string[] = []
    const belowEnd = Math.min(fileLines.length, hunk.endLine + contextBelow)
    for (let line = hunk.endLine + 1; line <= belowEnd; line += 1) {
      below.push(fileLines[line - 1] ?? '')
    }
    return { above, below }
  })

  const contextAvailable = $derived.by(() => {
    const hunk = activeHunkData
    if (!hunk) return { above: 0, below: 0 }
    return {
      above: Math.max(0, hunk.startLine - 1),
      below: Math.max(0, fileLines.length - hunk.endLine)
    }
  })

  /**
   * Create the three CodeMirror editors: read-only incoming (left) and current
   * (right) hunk blocks, and the editable result (middle) carrying the current
   * resolution. Recreated when the focused hunk or the host nodes change. The
   * current resolution is read through `untrack` so typing never tears it down.
   */
  $effect(() => {
    const hunk = activeHunkData
    if (!hunk || !theirsHost || !resultHost || !oursHost) return

    const snapshot = untrack(() => ({
      theirs: hunk.theirs,
      ours: hunk.ours,
      result: resolutions[activeHunk] ?? ''
    }))

    let cancelled = false
    let editors: FileEditorController[] = []

    void Promise.all([
      createFileEditor({
        host: theirsHost,
        value: snapshot.theirs,
        path,
        readonly: true,
        showLineNumbers: true,
        ariaLabel: `Incoming version of ${path} — conflict ${activeHunk + 1}`,
        onDocChange: () => {}
      }),
      createFileEditor({
        host: resultHost,
        value: snapshot.result,
        path,
        readonly: false,
        showLineNumbers: true,
        ariaLabel: `Result for ${path} — conflict ${activeHunk + 1}`,
        onDocChange: (text) => {
          if (cancelled) return
          resultEditorText = text
          if (resolutions[activeHunk] === text) return
          const next = [...resolutions]
          next[activeHunk] = text
          past = [...past, [...resolutions]]
          future = []
          resolutions = next
          syncToFile(next)
        }
      }),
      createFileEditor({
        host: oursHost,
        value: snapshot.ours,
        path,
        readonly: true,
        showLineNumbers: true,
        ariaLabel: `Current version of ${path} — conflict ${activeHunk + 1}`,
        onDocChange: () => {}
      })
    ]).then(([theirs, result, ours]) => {
      if (cancelled) {
        theirs.destroy()
        result.destroy()
        ours.destroy()
        return
      }
      editors = [theirs, result, ours]
      resultController = result
      resultEditorText = snapshot.result
    })

    return () => {
      cancelled = true
      for (const editor of editors) editor.destroy()
      resultController = null
      resultEditorText = null
    }
  })

  // Apply external resolution changes (Accept / Merge / undo / accept-all) to
  // the mounted result editor without recreating it.
  $effect(() => {
    const editor = resultController
    if (!editor) return
    const text = resolutions[activeHunk] ?? ''
    if (text === resultEditorText) return
    resultEditorText = text
    editor.setValue(text)
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex min-h-0 flex-1 flex-col">
    {#if loading && !analysis}
      <div class="flex flex-1 items-center justify-center gap-2 py-12 text-xs text-dimmed">
        <Loader2 size={14} class="animate-spin" />
        Analyzing conflict
      </div>
    {:else if error}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center">
        <FileWarning size={22} class="text-dimmed" />
        <p class="text-xs font-medium text-muted">Could not analyze this file</p>
        <p class="max-w-[40ch] text-[10px] leading-relaxed text-danger">{error}</p>
        <button
          type="button"
          class="rounded-md border border-border px-2.5 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => void openInEditor()}
        >
          Open in editor
        </button>
      </div>
    {:else if !analysis}
      <div class="flex flex-1 items-center justify-center py-12 text-xs text-dimmed">
        No analysis available.
      </div>
    {:else if analysis.binary}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center">
        <FileWarning size={22} class="text-dimmed" />
        <p class="text-xs font-medium text-muted">Binary file</p>
        <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">
          This file cannot be resolved in the panel — open it in the editor and resolve the conflict
          there.
        </p>
        <button
          type="button"
          class="rounded-md border border-border px-2.5 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => void openInEditor()}
        >
          Open in editor
        </button>
      </div>
    {:else if analysis.truncated}
      <div class="flex flex-1 flex-col items-center justify-center gap-3 px-8 py-12 text-center">
        <AlertTriangle size={22} class="text-warning" />
        <p class="text-xs font-medium text-muted">File too large to resolve here</p>
        <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">
          This file exceeds the resolution preview bound — open it in the editor to resolve the
          conflict.
        </p>
        <button
          type="button"
          class="rounded-md border border-border px-2.5 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={() => void openInEditor()}
        >
          Open in editor
        </button>
      </div>
    {:else if analysis}
      {@const currentAnalysis = analysis}
      <!-- Summary bar -->
      <div class="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
        <GitMerge size={12} class="shrink-0 text-warning" />
        <span class="text-[10px] font-semibold text-foreground">
          Conflict {activeHunk + 1} of {currentAnalysis.hunks.length}
        </span>
        <span class="tabular-nums font-mono text-[9px] text-dimmed">
          lines {activeHunkData?.startLine ?? 0}–{activeHunkData?.endLine ?? 0}
        </span>
        <span class="flex-1"></span>
        {#if resolvedCount > 0}
          <span
            class="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-success"
          >
            {resolvedCount}/{currentAnalysis.hunks.length} resolved
          </span>
        {:else}
          <span class="shrink-0 text-[9px] text-dimmed"
            >0/{currentAnalysis.hunks.length} resolved</span
          >
        {/if}
        <span class="mx-1 h-4 w-px shrink-0 bg-border"></span>
        <button
          type="button"
          class="shrink-0 rounded border border-accent/40 px-1.5 py-0.5 text-[9px] font-medium text-accent transition-colors hover:bg-accent/10"
          title="Set every conflict to the incoming side"
          onclick={() => acceptAll('incoming')}
        >
          Accept all incoming
        </button>
        <button
          type="button"
          class="shrink-0 rounded border border-primary/40 px-1.5 py-0.5 text-[9px] font-medium text-primary transition-colors hover:bg-primary/10"
          title="Set every conflict to the current side"
          onclick={() => acceptAll('current')}
        >
          Accept all current
        </button>
      </div>

      <!-- Hunk navigation + undo/redo -->
      <div
        class="flex shrink-0 items-center gap-1 border-b border-border bg-elevated/30 px-2 py-1.5"
      >
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-30"
          title="Previous conflict"
          aria-label="Previous conflict"
          disabled={activeHunk === 0}
          onclick={() => (activeHunk = Math.max(0, activeHunk - 1))}
        >
          <ArrowLeftToLine size={12} />
        </button>
        <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1">
          {#each currentAnalysis.hunks as hunk, index (index)}
            {@const resolved = typeof resolutions[index] === 'string'}
            <button
              type="button"
              class={[
                'flex h-6 shrink-0 items-center gap-1 rounded px-1.5 font-mono text-[9px] tabular-nums transition-colors',
                index === activeHunk
                  ? 'bg-primary/15 text-primary'
                  : resolved
                    ? 'bg-success/10 text-success'
                    : 'text-dimmed hover:bg-elevated hover:text-foreground'
              ]}
              title={`Conflict ${index + 1} · lines ${hunk.startLine}–${hunk.endLine}${resolved ? ' · resolved' : ''}`}
              onclick={() => (activeHunk = index)}
            >
              {#if resolved}
                <Check size={9} />
              {/if}
              {index + 1}
            </button>
          {/each}
        </div>
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-30"
          title="Next conflict"
          aria-label="Next conflict"
          disabled={activeHunk >= currentAnalysis.hunks.length - 1}
          onclick={() => (activeHunk = Math.min(currentAnalysis.hunks.length - 1, activeHunk + 1))}
        >
          <ArrowRightToLine size={12} />
        </button>
        <span class="mx-1 h-4 w-px shrink-0 bg-border"></span>
        <button
          type="button"
          class="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-30"
          title="Undo (Cmd/Ctrl+Z)"
          aria-label="Undo"
          disabled={past.length === 0}
          onclick={undo}
        >
          <Undo2 size={11} />
        </button>
        <button
          type="button"
          class="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-30"
          title="Redo (Cmd/Ctrl+Shift+Z)"
          aria-label="Redo"
          disabled={future.length === 0}
          onclick={redo}
        >
          <Redo2 size={11} />
        </button>
      </div>

      {#if activeHunkData}
        {@const hunk = activeHunkData}
        {@const resolution = resolutions[activeHunk] ?? null}
        {@const resolved = typeof resolution === 'string'}
        <!-- Three-pane merge editor -->
        <div class="grid min-h-0 flex-1 grid-cols-3 gap-px bg-border">
          <!-- Incoming (left) : read-only incoming hunk -->
          <div class="flex min-h-0 min-w-0 flex-col bg-app">
            <div
              class="flex shrink-0 items-center gap-1.5 border-b border-border bg-elevated/50 px-2 py-1"
            >
              <span
                class="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-accent"
              >
                incoming
              </span>
              <span class="truncate font-mono text-[8px] text-dimmed">{hunk.theirsLabel}</span>
            </div>
            <div class="flex min-h-0 grow flex-col overflow-hidden">
              <div bind:this={theirsHost} class="h-full w-full" data-merge-pane></div>
            </div>
          </div>

          <!-- Result (middle) : real editor + expandable context -->
          <div class="flex min-h-0 min-w-0 flex-col bg-app">
            <div
              class="flex shrink-0 items-center gap-1.5 border-b border-border bg-elevated/50 px-2 py-1"
            >
              <span
                class="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-primary"
              >
                result
              </span>
              <span class="truncate font-mono text-[8px] text-dimmed">
                {resolved ? 'resolved' : 'unresolved'}
              </span>
            </div>
            <!-- Expand above (middle only) -->
            {#if contextAvailable.above > contextAbove}
              <button
                type="button"
                class="flex h-7 shrink-0 items-center justify-center gap-2 border-b border-border/40 bg-elevated/40 text-[9px] font-medium text-dimmed transition-colors hover:text-foreground"
                title="Reveal more lines above this conflict"
                onclick={() => (contextAbove = Math.min(contextAvailable.above, contextAbove + 5))}
              >
                <span class="h-px w-8 bg-border"></span>
                Show {Math.min(5, contextAvailable.above - contextAbove)} lines above
                <span class="h-px w-8 bg-border"></span>
              </button>
            {/if}
            {#if contextWindow.above.length > 0}
              <div
                class="shrink-0 border-b border-border/40 bg-app/60 font-mono text-[11px] leading-5 text-dimmed"
              >
                {#each contextWindow.above as line, index (index)}
                  <div class="flex items-center">
                    <span
                      class="w-10 shrink-0 select-none bg-elevated/30 px-2 text-right text-[9px] tabular-nums text-dimmed"
                    >
                      {Math.max(hunk.startLine - contextAbove, 1) + index}
                    </span>
                    <span class="min-w-0 flex-1 truncate whitespace-pre px-2">{line}</span>
                  </div>
                {/each}
              </div>
            {/if}
            <!-- Editable result editor -->
            <div class="flex min-h-20 min-w-0 grow flex-col overflow-hidden">
              <div bind:this={resultHost} class="h-full w-full" data-merge-pane></div>
            </div>
            {#if contextWindow.below.length > 0}
              <div
                class="shrink-0 border-t border-border/40 bg-app/60 font-mono text-[11px] leading-5 text-dimmed"
              >
                {#each contextWindow.below as line, index (index)}
                  <div class="flex items-center">
                    <span
                      class="w-10 shrink-0 select-none bg-elevated/30 px-2 text-right text-[9px] tabular-nums text-dimmed"
                    >
                      {hunk.endLine + 1 + index}
                    </span>
                    <span class="min-w-0 flex-1 truncate whitespace-pre px-2">{line}</span>
                  </div>
                {/each}
              </div>
            {/if}
            {#if contextAvailable.below > contextBelow}
              <button
                type="button"
                class="flex h-7 shrink-0 items-center justify-center gap-2 border-t border-border/40 bg-elevated/40 text-[9px] font-medium text-dimmed transition-colors hover:text-foreground"
                title="Reveal more lines below this conflict"
                onclick={() => (contextBelow = Math.min(contextAvailable.below, contextBelow + 5))}
              >
                <span class="h-px w-8 bg-border"></span>
                Show {Math.min(5, contextAvailable.below - contextBelow)} lines below
                <span class="h-px w-8 bg-border"></span>
              </button>
            {/if}
          </div>

          <!-- Current (right) : read-only current hunk -->
          <div class="flex min-h-0 min-w-0 flex-col bg-app">
            <div
              class="flex shrink-0 items-center gap-1.5 border-b border-border bg-elevated/50 px-2 py-1"
            >
              <span
                class="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-primary"
              >
                current
              </span>
              <span class="truncate font-mono text-[8px] text-dimmed">{hunk.oursLabel}</span>
            </div>
            <div class="flex min-h-0 grow flex-col overflow-hidden">
              <div bind:this={oursHost} class="h-full w-full" data-merge-pane></div>
            </div>
          </div>
        </div>

        {#if error}
          <p
            class="border-b border-danger/25 bg-danger/10 px-3 py-2 text-[10px] leading-relaxed text-danger"
          >
            {error}
          </p>
        {/if}

        <!-- Per-hunk accept actions -->
        <div
          class="flex shrink-0 items-center gap-2 border-t border-border/40 bg-surface/60 px-3 py-2"
        >
          <button
            type="button"
            class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-accent/50 bg-accent/15 px-3 text-[11px] font-semibold text-accent transition-colors hover:bg-accent/25"
            title={`Use the incoming side (${hunk.theirsLabel}) for this conflict`}
            onclick={() => resolveHunk(activeHunk, hunk.theirs)}
          >
            <ArrowLeftToLine size={13} />
            Accept incoming
          </button>
          <span class="text-[9px] text-dimmed">or</span>
          <button
            type="button"
            class="flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-primary/50 bg-primary/15 px-3 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/25"
            title={`Use the current side (${hunk.oursLabel}) for this conflict`}
            onclick={() => resolveHunk(activeHunk, hunk.ours)}
          >
            Accept current
            <ArrowRightToLine size={13} />
          </button>
          <span class="flex-1"></span>
          <button
            type="button"
            class="h-8 shrink-0 rounded border border-border px-2.5 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Keep both sides, stacked"
            onclick={() => mergeBoth(activeHunk)}
          >
            Merge both
          </button>
          {#if resolved}
            <button
              type="button"
              class="h-8 shrink-0 rounded border border-border px-2.5 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Clear this resolution back to unresolved"
              onclick={() => clearHunk(activeHunk)}
            >
              <Undo2 size={12} />
            </button>
          {/if}
        </div>
      {/if}
    {/if}
  </div>
</div>
