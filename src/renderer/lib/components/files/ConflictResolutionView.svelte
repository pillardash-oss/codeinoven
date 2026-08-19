<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { AlertTriangle, FileWarning, GitMerge, Loader2, Save, Undo2 } from '@lucide/svelte'
  import type { GitConflictAnalysis, GitConflictHunk } from '$shared/types'
  import { gitState } from '$lib/stores/git.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'

  interface Props {
    projectId: string
    /** The conflicted file being resolved. */
    path: string
    /** Invoked after a successful save; the host can advance to the next conflict. */
    onSaved?: (path: string, remaining: string[]) => void
  }

  let { projectId, path, onSaved }: Props = $props()

  let analysis = $state<GitConflictAnalysis | null>(null)
  let loading = $state(false)
  let error = $state<string | null>(null)
  /** Per-hunk resolution text; null means that hunk is not decided yet. */
  let resolutions = $state<(string | null)[]>([])
  let saving = $state(false)
  let saveError = $state<string | null>(null)

  $effect(() => {
    let cancelled = false
    loading = true
    error = null
    analysis = null
    resolutions = []
    saveError = null
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

  const isSaveable = $derived(
    analysis !== null &&
      !analysis.binary &&
      !analysis.truncated &&
      resolutions.length > 0 &&
      resolutions.every((resolution) => typeof resolution === 'string')
  )

  const resolvedCount = $derived(
    resolutions.filter((resolution) => typeof resolution === 'string').length
  )

  function assembleContent(): string {
    const current = analysis
    if (!current) return ''
    const lines = current.content.split('\n')
    const hunks = current.hunks
    for (let index = hunks.length - 1; index >= 0; index -= 1) {
      const hunk = hunks[index]
      const resolution = resolutions[index]
      if (!hunk || !hunk.startLine || !hunk.endLine) continue
      if (typeof resolution !== 'string') continue
      lines.splice(hunk.startLine - 1, hunk.endLine - hunk.startLine + 1, ...resolution.split('\n'))
    }
    return lines.join('\n')
  }

  async function saveFile(): Promise<void> {
    if (!isSaveable || saving) return
    saving = true
    saveError = null
    try {
      const content = assembleContent()
      const saved = await gitState.saveConflictResolution(projectId, path, content)
      if (saved) {
        await gitState.refresh(projectId)
        onSaved?.(path, [...gitState.conflicted])
        return
      }
      saveError = gitState.error ?? 'The conflict could not be saved'
    } catch (reason) {
      saveError =
        reason instanceof Error
          ? reason.message
          : (gitState.error ?? 'The conflict could not be saved')
    } finally {
      saving = false
    }
  }

  function resolveHunk(index: number, resolution: string): void {
    const next = [...resolutions]
    next[index] = resolution
    resolutions = next
  }

  function clearHunk(index: number): void {
    const next = [...resolutions]
    next[index] = null
    resolutions = next
  }

  function mergeBoth(index: number): void {
    const hunk = analysis?.hunks[index]
    if (!hunk) return
    resolveHunk(
      index,
      [hunk.ours, hunk.theirs].filter((side) => side.trim().length > 0).join('\n\n')
    )
  }

  async function openInEditor(): Promise<void> {
    try {
      await projectFilesWorkspace.openFile(projectId, path)
    } catch {
      // Editor open failed — nothing else to do.
    }
  }

  /** One unchanged source line; its per-pane line numbers. */
  interface ContextLine {
    kind: 'context'
    text: string
    theirs: number
    current: number
    result: number
  }

  /** An immediately preceding line shown for orientation before a conflict. */
  interface ConflictLine {
    kind: 'conflict'
    index: number
    hunk: GitConflictHunk
    theirs: string
    ours: string
  }

  type ViewRow = ContextLine | ConflictLine

  /**
   * Rebuild the file as an ordered row list so the three panes stay aligned:
   * unchanged regions render once (shared across panes), and each conflict
   * block replaces its region with the incoming/result/current triple. Context
   * rows around every hunk keep each block anchored to its real position.
   */
  const viewRows = $derived.by((): ViewRow[] => {
    const current = analysis
    if (!current) return []
    const fileLines = current.content.split('\n')
    const rows: ViewRow[] = []
    let cursor = 0
    let theirsNumber = 1
    let currentNumber = 1
    let resultNumber = 1

    for (let index = 0; index < current.hunks.length; index += 1) {
      const hunk = current.hunks[index]
      for (let line = cursor; line < hunk.startLine - 1; line += 1) {
        rows.push({
          kind: 'context',
          text: fileLines[line] ?? '',
          theirs: theirsNumber,
          current: currentNumber,
          result: resultNumber
        })
        theirsNumber += 1
        currentNumber += 1
        resultNumber += 1
      }
      cursor = hunk.endLine
      rows.push({ kind: 'conflict', index, hunk, theirs: hunk.theirs, ours: hunk.ours })
    }
    for (let line = cursor; line < fileLines.length - 1; line += 1) {
      rows.push({
        kind: 'context',
        text: fileLines[line] ?? '',
        theirs: theirsNumber,
        current: currentNumber,
        result: resultNumber
      })
      theirsNumber += 1
      currentNumber += 1
      resultNumber += 1
    }
    return rows
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
    {:else}
      <!-- Summary -->
      <div class="flex shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
        <GitMerge size={12} class="shrink-0 text-warning" />
        <span class="text-[10px] font-medium text-foreground">
          {analysis.hunks.length} conflict {analysis.hunks.length === 1 ? 'hunk' : 'hunks'}
        </span>
        <span class="text-[9px] tabular-nums text-dimmed">
          lines {analysis.hunks[0]?.startLine ?? 0}–{analysis.hunks.at(-1)?.endLine ?? 0}
        </span>
        <span class="flex-1"></span>
        {#if resolvedCount > 0}
          <span
            class="shrink-0 rounded bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold tabular-nums text-success"
          >
            {resolvedCount}/{analysis.hunks.length} resolved
          </span>
        {:else}
          <span class="shrink-0 text-[9px] text-dimmed">0/{analysis.hunks.length} resolved</span>
        {/if}
      </div>

      <!-- Three-pane column headers -->
      <div
        class="grid shrink-0 grid-cols-3 border-b border-border bg-elevated/50 text-[9px] font-semibold uppercase tracking-wide text-muted"
      >
        <div class="border-r border-border px-3 py-1.5">
          Incoming · {analysis.hunks[0]?.theirsLabel ?? 'theirs'}
        </div>
        <div class="border-r border-border px-3 py-1.5">Result</div>
        <div class="px-3 py-1.5">Current · {analysis.hunks[0]?.oursLabel ?? 'ours'}</div>
      </div>

      <!-- Aligned rows -->
      <div class="min-h-0 flex-1 overflow-x-hidden overflow-y-auto">
        {#each viewRows as row (row.kind === 'conflict' ? `conflict:${row.index}` : `ctx:${row.result}`)}
          {#if row.kind === 'context'}
            <div
              class="grid grid-cols-3 border-b border-border/40 font-mono text-[11px] leading-5 text-foreground"
            >
              <div class="flex min-w-0 items-center border-r border-border/40">
                <span
                  class="w-10 shrink-0 select-none bg-elevated/30 px-2 text-right text-[9px] tabular-nums text-dimmed"
                >
                  {row.theirs}
                </span>
                <span class="min-w-0 flex-1 truncate whitespace-pre px-2">{row.text}</span>
              </div>
              <div class="flex min-w-0 items-center border-r border-border/40">
                <span
                  class="w-10 shrink-0 select-none bg-elevated/30 px-2 text-right text-[9px] tabular-nums text-dimmed"
                >
                  {row.result}
                </span>
                <span class="min-w-0 flex-1 truncate whitespace-pre px-2">{row.text}</span>
              </div>
              <div class="flex min-w-0 items-center">
                <span
                  class="w-10 shrink-0 select-none bg-elevated/30 px-2 text-right text-[9px] tabular-nums text-dimmed"
                >
                  {row.current}
                </span>
                <span class="min-w-0 flex-1 truncate whitespace-pre px-2">{row.text}</span>
              </div>
            </div>
          {:else}
            {@const resolution = resolutions[row.index] ?? null}
            {@const resolved = typeof resolution === 'string'}
            <div class="grid grid-cols-3 border-b border-border/40">
              <!-- Incoming (theirs) -->
              <div class="min-w-0 border-r border-border/40 bg-danger/5">
                <div class="flex items-center gap-1 px-3 py-1">
                  <span
                    class="rounded bg-accent/15 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-accent"
                  >
                    theirs
                  </span>
                  <span class="truncate font-mono text-[8px] text-dimmed"
                    >{row.hunk.theirsLabel}</span
                  >
                  <span class="flex-1"></span>
                  <button
                    type="button"
                    class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                    title="Use the incoming side for this conflict"
                    onclick={() => resolveHunk(row.index, row.theirs)}
                  >
                    Use
                  </button>
                </div>
                {#if row.theirs.trim().length === 0}
                  <p class="px-3 pb-2 font-mono text-[9px] italic text-dimmed">(empty)</p>
                {:else}
                  <pre
                    class="mb-1 whitespace-pre-wrap px-3 pb-2 pt-0.5 font-mono text-[10px] leading-5 text-foreground">{row.theirs}</pre>
                {/if}
              </div>

              <!-- Result -->
              <div class="min-w-0 border-r border-border/40 bg-surface">
                <div class="flex items-center gap-1 px-3 py-1">
                  <span
                    class="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-primary"
                  >
                    Conflict {row.index + 1}
                  </span>
                  <span class="tabular-nums font-mono text-[8px] text-dimmed">
                    lines {row.hunk.startLine}–{row.hunk.endLine}
                  </span>
                  <span class="flex-1"></span>
                  {#if resolved}
                    <span
                      class="rounded bg-success/15 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-success"
                    >
                      resolved
                    </span>
                    <button
                      type="button"
                      class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                      title="Clear this resolution back to unresolved"
                      onclick={() => clearHunk(row.index)}
                    >
                      <Undo2 size={10} />
                    </button>
                  {/if}
                </div>
                <textarea
                  class="mb-1 w-full resize-none rounded border border-border bg-app px-2.5 py-1.5 font-mono text-[10px] leading-5 text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                  rows={Math.max(2, row.theirs.split('\n').length, row.ours.split('\n').length)}
                  placeholder="Choose a side, merge both, or type the resolution…"
                  value={resolution ?? ''}
                  oninput={(event) => resolveHunk(row.index, event.currentTarget.value)}></textarea>
                <div class="flex items-center gap-2 px-3 pb-1.5">
                  <button
                    type="button"
                    class="rounded border border-border px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                    title="Keep both sides, stacked"
                    onclick={() => mergeBoth(row.index)}
                  >
                    Merge both
                  </button>
                </div>
              </div>

              <!-- Current (ours) -->
              <div class="min-w-0 bg-success/5">
                <div class="flex items-center gap-1 px-3 py-1">
                  <span
                    class="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[8px] font-semibold text-primary"
                  >
                    ours
                  </span>
                  <span class="truncate font-mono text-[8px] text-dimmed">{row.hunk.oursLabel}</span
                  >
                  <span class="flex-1"></span>
                  <button
                    type="button"
                    class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                    title="Use the current side for this conflict"
                    onclick={() => resolveHunk(row.index, row.ours)}
                  >
                    Use
                  </button>
                </div>
                {#if row.ours.trim().length === 0}
                  <p class="px-3 pb-2 font-mono text-[9px] italic text-dimmed">(empty)</p>
                {:else}
                  <pre
                    class="mb-1 whitespace-pre-wrap px-3 pb-2 pt-0.5 font-mono text-[10px] leading-5 text-foreground">{row.ours}</pre>
                {/if}
              </div>
            </div>
          {/if}
        {/each}
        {#if saveError}
          <p
            class="border-b border-danger/25 bg-danger/10 px-3 py-2 text-[10px] leading-relaxed text-danger"
          >
            {saveError}
          </p>
        {/if}
      </div>

      <!-- Footer bar -->
      <div class="flex shrink-0 items-center gap-2 border-t border-border bg-surface px-3 py-2">
        <span class="flex-1"></span>
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-40"
          disabled={!isSaveable || saving}
          onclick={() => void saveFile()}
        >
          {#if saving}
            <Loader2 size={11} class="animate-spin" />
          {:else}
            <Save size={11} />
          {/if}
          Save resolved file
        </button>
      </div>
    {/if}
  </div>
</div>
