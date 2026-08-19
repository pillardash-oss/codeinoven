<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import {
    AlertTriangle,
    ArrowLeft,
    Check,
    FileWarning,
    GitMerge,
    Loader2,
    Save,
    X
  } from '@lucide/svelte'
  import type { GitConflictAnalysis } from '$shared/types'
  import { gitState } from '$lib/stores/git.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { registerOverlayClose } from '$lib/overlay-close.svelte'
  import FileTypeIcon from '../files/FileTypeIcon.svelte'

  interface Props {
    projectId: string
    /** The conflicted paths to work through, ordered. */
    paths: string[]
    /** The file to focus on first (undefined = first path). */
    initialPath?: string
    onClose: () => void
  }

  let { projectId, paths, initialPath, onClose }: Props = $props()

  interface FileState {
    analysis: GitConflictAnalysis | null
    loading: boolean
    error: string | null
    /** Per-hunk resolution text; null means the hunk is not resolved yet. */
    resolutions: (string | null)[]
    /** True once the file has been saved (staged) successfully. */
    saved: boolean
    saving: boolean
    saveError: string | null
  }

  let activePath = $state<string | null>(null)
  let states = $state<Record<string, FileState>>({})
  let notice = $state<string | null>(null)
  /** Per-hunk textarea refs, for default-focus on open (index 0 = first hunk). */
  let textareaRefs: HTMLTextAreaElement[] = []

  function fileState(path: string): FileState | undefined {
    return states[path]
  }

  function ensureState(path: string): FileState {
    let existing = states[path]
    if (!existing) {
      existing = {
        analysis: null,
        loading: false,
        error: null,
        resolutions: [],
        saved: false,
        saving: false,
        saveError: null
      }
      states = { ...states, [path]: existing }
    }
    return existing
  }

  async function analyze(path: string): Promise<void> {
    const state = ensureState(path)
    if (state.analysis || state.loading) return
    state.loading = true
    state.error = null
    try {
      const analysis = await invoke('git:analyzeConflict', projectId, path)
      state.analysis = analysis
      state.resolutions = analysis.hunks.map(() => null)
    } catch (reason) {
      state.error = reason instanceof Error ? reason.message : 'The conflict could not be analyzed'
    } finally {
      state.loading = false
    }
  }

  function selectPath(path: string | null): void {
    activePath = path
    if (path) void analyze(path)
  }

  function isFileSaveable(path: string | null): boolean {
    if (!path) return false
    const state = states[path]
    const analysis = state?.analysis
    if (!analysis || analysis.binary || analysis.truncated) return false
    // A conflicted entry with no remaining conflict blocks only needs staging —
    // the markers were removed on disk (e.g. in the editor), so it is saveable.
    if (state.resolutions.length === 0) return analysis.hunks.length === 0
    return state.resolutions.every((resolution) => typeof resolution === 'string')
  }

  /** Reassemble the file content from the original with each hunk's resolution spliced in. */
  function assembleContent(state: FileState): string {
    const analysis = state.analysis
    if (!analysis) return ''
    const lines = analysis.content.split('\n')
    const hunks = analysis.hunks
    for (let index = hunks.length - 1; index >= 0; index -= 1) {
      const hunk = hunks[index]
      const resolution = state.resolutions[index]
      if (!hunk || !hunk.startLine || !hunk.endLine) continue
      if (typeof resolution !== 'string') continue
      lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...resolution.split('\n'))
    }
    return lines.join('\n')
  }

  async function saveFile(path: string | null): Promise<boolean> {
    if (!path) return false
    const state = ensureState(path)
    if (!isFileSaveable(path) || state.saving) return false
    state.saving = true
    state.saveError = null
    try {
      const content = assembleContent(state)
      const saved = await gitState.saveConflictResolution(projectId, path, content)
      if (saved) {
        state.saved = true
        state.resolutions = []
        // Refresh status so the staged file lands where it belongs and the
        // conflicted list shrinks.
        await gitState.refresh(projectId)
        return true
      }
      state.saveError = gitState.error
      return false
    } catch (reason) {
      state.saveError =
        reason instanceof Error
          ? reason.message
          : (gitState.error ?? 'The conflict could not be saved')
      return false
    } finally {
      state.saving = false
    }
  }

  async function saveAll(): Promise<void> {
    const saveable = paths.filter((path) => isFileSaveable(path) && !fileState(path)?.saved)
    if (saveable.length === 0) return
    notice = `Saving ${saveable.length} ${saveable.length === 1 ? 'file' : 'files'}…`
    let saved = 0
    for (const path of saveable) {
      if (await saveFile(path)) saved += 1
    }
    if (saved > 0) {
      notice = `Saved ${saved} ${saved === 1 ? 'file' : 'files'}`
    } else {
      notice = null
    }
  }

  function resolveHunk(path: string | null, index: number, resolution: string): void {
    if (!path) return
    const state = ensureState(path)
    if (!state.analysis) return
    const next = [...state.resolutions]
    next[index] = resolution
    state.resolutions = next
  }

  function clearHunk(path: string | null, index: number): void {
    if (!path) return
    const state = ensureState(path)
    const next = [...state.resolutions]
    next[index] = null
    state.resolutions = next
  }

  async function openInEditor(path: string | null): Promise<void> {
    if (!path) return
    try {
      await projectFilesWorkspace.openFile(projectId, path)
    } catch {
      // Editor open failed — nothing else to do.
    }
  }

  const remainingPaths = $derived(paths.filter((path) => !fileState(path)?.saved))
  const activeState = $derived(activePath ? (fileState(activePath) ?? null) : null)

  $effect(() => {
    if (!activePath) return
    return registerOverlayClose(onClose)
  })

  // Default modal focus: focus the first resolution textarea once hunks render.
  let autoFocused = false
  $effect(() => {
    if (textareaRefs[0] && !autoFocused) {
      textareaRefs[0].focus({ preventScroll: true })
      autoFocused = true
    }
  })

  $effect(() => {
    // After a save drops a file from the conflicted set (paths refreshes from
    // git), jump to the next still-conflicted file so the user can keep walking
    // the list. When nothing is left, fall back to a completion state.
    if (activePath && !paths.includes(activePath)) {
      const next = paths.find((path) => !fileState(path)?.saved)
      activePath = next ?? null
    }
  })

  $effect(() => {
    // Focus the requested file on open (or the first conflicted one).
    const initial = initialPath && paths.includes(initialPath) ? initialPath : paths[0]
    if (initial && !activePath) selectPath(initial)
  })
</script>

<div class="fixed inset-0 z-60 flex items-center justify-center">
  <button
    class="absolute inset-0 bg-overlay/70 backdrop-blur-[1px]"
    aria-label="Close conflict resolution"
    title="Close conflict resolution"
    onclick={onClose}
  ></button>

  <div
    class="relative mx-6 flex h-[min(42rem,calc(100vh-4rem))] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-app shadow-xl"
  >
    <div
      class="flex shrink-0 items-center justify-between border-b border-border bg-surface px-5 py-3"
    >
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-foreground">Resolve conflicts</h2>
        <p class="truncate text-[10px] text-muted">
          {remainingPaths.length}
          {remainingPaths.length === 1 ? 'file' : 'files'} left to resolve · saved files are staged automatically
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        {#if notice}
          <p class="text-[10px] text-muted">{notice}</p>
        {/if}
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
          disabled={remainingPaths.filter((path) => isFileSaveable(path)).length === 0}
          onclick={() => void saveAll()}
        >
          <Save size={12} />
          Save all
        </button>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close conflict resolution"
          title="Close conflict resolution"
          onclick={onClose}
        >
          <X size={16} />
        </button>
      </div>
    </div>

    <div class="flex min-h-0 flex-1">
      <!-- File rail -->
      <aside class="w-56 shrink-0 overflow-y-auto border-r border-border bg-surface">
        <div class="sticky top-0 border-b border-border bg-surface px-3 py-2">
          <p class="text-[9px] font-semibold uppercase tracking-wide text-muted">
            Conflicted files
          </p>
        </div>
        <div class="py-1">
          {#each paths as path (path)}
            {@const state = fileState(path)}
            {@const done = state?.saved}
            {@const saveable = isFileSaveable(path)}
            <button
              type="button"
              class={[
                'flex h-8 w-full cursor-pointer items-center gap-2 px-3 text-left transition-colors',
                activePath === path ? 'bg-primary/10' : 'hover:bg-elevated/50'
              ]}
              aria-label={`${done ? 'Saved' : 'Conflicted'} ${path}`}
              title={done ? `${path} — resolved and staged` : path}
              onclick={() => selectPath(path)}
            >
              {#if state?.loading}
                <Loader2 size={12} class="shrink-0 animate-spin text-dimmed" />
              {:else if done}
                <Check size={12} class="shrink-0 text-success" />
              {:else}
                <AlertTriangle size={12} class="shrink-0 text-warning" />
              {/if}
              <FileTypeIcon {path} size={12} class="shrink-0" />
              <span class="min-w-0 flex-1 truncate font-mono text-[10px] text-muted">
                {path.split('/').pop()}
              </span>
              {#if saveable && !done}
                <span class="shrink-0 text-[8px] font-medium uppercase tracking-wide text-success">
                  ready
                </span>
              {/if}
            </button>
          {/each}
        </div>
      </aside>

      <!-- Editor -->
      <main class="min-w-0 flex-1 overflow-y-auto">
        {#if activePath && activeState}
          <div class="flex h-full flex-col">
            <!-- File header -->
            <div
              class="sticky top-0 z-10 flex shrink-0 items-center gap-2 border-b border-border bg-app px-4 py-2.5"
            >
              <FileTypeIcon path={activePath} size={14} class="shrink-0" />
              <div class="min-w-0 flex-1">
                <p class="truncate font-mono text-[11px] font-medium text-foreground">
                  {activePath}
                </p>
                {#if activeState.analysis}
                  <p class="text-[9px] text-dimmed">
                    {activeState.analysis.hunks.length} conflict
                    {activeState.analysis.hunks.length === 1 ? 'hunk' : 'hunks'} · lines
                    {activeState.analysis.hunks[0]?.startLine ?? 0}–
                    {activeState.analysis.hunks.at(-1)?.endLine ?? 0}
                  </p>
                {/if}
              </div>
              <button
                type="button"
                class="shrink-0 rounded-md border border-border px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                title="Open {activePath} in the editor"
                onclick={() => void openInEditor(activePath)}
              >
                Open in editor
              </button>
              <button
                type="button"
                class="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
                disabled={!isFileSaveable(activePath) || activeState.saving}
                onclick={() => void saveFile(activePath)}
              >
                {#if activeState.saving}
                  <Loader2 size={11} class="animate-spin" />
                {:else}
                  <Save size={11} />
                {/if}
                Save file
              </button>
            </div>

            {#if activeState.loading}
              <div class="flex flex-1 items-center justify-center gap-2 py-12 text-xs text-dimmed">
                <Loader2 size={14} class="animate-spin" />
                Analyzing conflict
              </div>
            {:else if activeState.error}
              <div class="flex flex-col items-center justify-center gap-3 px-8 py-12 text-center">
                <FileWarning size={22} class="text-dimmed" />
                <p class="text-xs font-medium text-muted">Could not analyze this file</p>
                <p class="max-w-[40ch] text-[10px] leading-relaxed text-danger">
                  {activeState.error}
                </p>
              </div>
            {:else if !activeState.analysis}
              <div class="flex flex-1 items-center justify-center py-12 text-xs text-dimmed">
                No analysis available.
              </div>
            {:else if activeState.analysis.binary}
              <div class="flex flex-col items-center justify-center gap-3 px-8 py-12 text-center">
                <FileWarning size={22} class="text-dimmed" />
                <p class="text-xs font-medium text-muted">Binary file</p>
                <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">
                  This file cannot be resolved in the panel — open it in the editor and resolve the
                  conflict there.
                </p>
                <button
                  type="button"
                  class="rounded-md border border-border px-2.5 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
                  onclick={() => void openInEditor(activePath)}
                >
                  Open in editor
                </button>
              </div>
            {:else if activeState.analysis.truncated}
              <div class="flex flex-col items-center justify-center gap-3 px-8 py-12 text-center">
                <AlertTriangle size={22} class="text-warning" />
                <p class="text-xs font-medium text-muted">File too large to resolve here</p>
                <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">
                  This file exceeds the resolution preview bound — open it in the editor to resolve
                  the conflict.
                </p>
                <button
                  type="button"
                  class="rounded-md border border-border px-2.5 py-1 text-[10px] font-medium text-muted hover:bg-elevated hover:text-foreground"
                  onclick={() => void openInEditor(activePath)}
                >
                  Open in editor
                </button>
              </div>
            {:else}
              <div class="flex-1 space-y-3 p-4">
                {#if activeState.saved}
                  <div
                    class="flex items-center gap-2 rounded-lg border border-success/25 bg-success/10 px-3 py-2.5"
                  >
                    <Check size={14} class="shrink-0 text-success" />
                    <p class="text-[11px] font-medium text-foreground">
                      {activePath} resolved and staged.
                    </p>
                  </div>
                {/if}
                {#each activeState.analysis.hunks as hunk, index (index)}
                  {@const resolution = activeState.resolutions[index] ?? null}
                  {@const resolved = typeof resolution === 'string'}
                  <section
                    class="overflow-hidden rounded-xl border {resolved
                      ? 'border-success/30'
                      : 'border-warning/30'} bg-surface"
                  >
                    <div
                      class="flex items-center gap-2 border-b border-border bg-elevated/40 px-3 py-1.5"
                    >
                      <GitMerge size={12} class="shrink-0 text-warning" />
                      <span class="text-[10px] font-semibold text-foreground">
                        Conflict {index + 1}
                      </span>
                      <span class="text-[9px] tabular-nums text-dimmed">
                        lines {hunk.startLine}–{hunk.endLine}
                      </span>
                      <span class="flex-1"></span>
                      {#if resolved}
                        <span
                          class="rounded bg-success/15 px-1.5 py-0.5 text-[8px] font-semibold uppercase tracking-wide text-success"
                        >
                          resolved
                        </span>
                      {/if}
                    </div>

                    <div class="grid grid-cols-2 gap-px bg-border">
                      <div class="min-w-0 bg-surface">
                        <div class="flex items-center gap-1.5 px-3 py-1.5">
                          <span
                            class="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-primary"
                          >
                            ours
                          </span>
                          <span class="truncate font-mono text-[8px] text-dimmed">
                            {hunk.oursLabel}
                          </span>
                          <span class="flex-1"></span>
                          <button
                            type="button"
                            class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
                            title="Keep the current (ours) side for this conflict"
                            disabled={hunk.ours === resolution}
                            onclick={() => resolveHunk(activePath, index, hunk.ours)}
                          >
                            Accept ours
                          </button>
                        </div>
                        <pre
                          class="max-h-48 min-h-12 overflow-auto whitespace-pre-wrap px-3 pb-2 font-mono text-[10px] leading-5 text-foreground">{hunk.ours}</pre>
                      </div>
                      <div class="min-w-0 bg-surface">
                        <div class="flex items-center gap-1.5 px-3 py-1.5">
                          <span
                            class="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-accent"
                          >
                            theirs
                          </span>
                          <span class="truncate font-mono text-[8px] text-dimmed">
                            {hunk.theirsLabel}
                          </span>
                          <span class="flex-1"></span>
                          <button
                            type="button"
                            class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
                            title="Accept the incoming (theirs) side for this conflict"
                            disabled={hunk.theirs === resolution}
                            onclick={() => resolveHunk(activePath, index, hunk.theirs)}
                          >
                            Accept theirs
                          </button>
                        </div>
                        <pre
                          class="max-h-48 min-h-12 overflow-auto whitespace-pre-wrap px-3 pb-2 font-mono text-[10px] leading-5 text-foreground">{hunk.theirs}</pre>
                      </div>
                    </div>

                    <div class="border-t border-border px-3 py-2">
                      <div class="flex items-center gap-2">
                        <span
                          class="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-muted"
                        >
                          Result
                        </span>
                        <button
                          type="button"
                          class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
                          title="Keep both sides, stacked"
                          onclick={() =>
                            resolveHunk(
                              activePath,
                              index,
                              [hunk.ours, hunk.theirs]
                                .filter((side) => side.trim().length > 0)
                                .join('\n\n')
                            )}
                        >
                          Merge both
                        </button>
                        {#if resolved}
                          <button
                            type="button"
                            class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                            title="Clear this conflict back to unresolved"
                            onclick={() => clearHunk(activePath, index)}
                          >
                            Reset
                          </button>
                        {/if}
                      </div>
                      <textarea
                        bind:this={textareaRefs[index]}
                        class="mt-1.5 h-24 w-full resize-none rounded-md border border-border bg-app px-2.5 py-2 font-mono text-[10px] leading-5 text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                        placeholder="Choose a side above, merge both, or type your own resolution…"
                        value={resolution ?? ''}
                        oninput={(event) =>
                          resolveHunk(activePath, index, event.currentTarget.value)}></textarea>
                    </div>
                  </section>
                {/each}

                {#if activeState.saveError}
                  <p
                    class="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[10px] leading-relaxed text-danger"
                  >
                    {activeState.saveError}
                  </p>
                {/if}
              </div>
            {/if}
          </div>
        {:else if paths.length === 0}
          <div class="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
            <Check size={24} class="text-success" />
            <p class="text-xs font-medium text-muted">No conflicts to resolve</p>
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
              onclick={onClose}
            >
              Back to Git
            </button>
          </div>
        {:else}
          <div class="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <ArrowLeft size={18} class="text-dimmed" />
            <p class="text-[10px] text-muted">Select a conflicted file to begin.</p>
          </div>
        {/if}
      </main>
    </div>
  </div>
</div>
