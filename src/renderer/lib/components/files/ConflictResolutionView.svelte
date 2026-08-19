<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { AlertTriangle, FileWarning, GitMerge, Loader2, Save } from '@lucide/svelte'
  import type { GitConflictAnalysis } from '$shared/types'
  import { gitState } from '$lib/stores/git.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'

  interface Props {
    projectId: string
    /** The conflicted file being resolved. */
    path: string
    /**
     * Invoked after a successful save (the file has been staged and left the
     * conflicted set), so the host can advance to the next conflicted file.
     */
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
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
    {#if loading && !analysis}
      <div class="flex flex-1 items-center justify-center gap-2 py-12 text-xs text-dimmed">
        <Loader2 size={14} class="animate-spin" />
        Analyzing conflict
      </div>
    {:else if error}
      <div class="flex flex-col items-center justify-center gap-3 px-8 py-12 text-center">
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
      <div class="flex flex-col items-center justify-center gap-3 px-8 py-12 text-center">
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
      <div class="flex flex-col items-center justify-center gap-3 px-8 py-12 text-center">
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
      <div class="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <GitMerge size={12} class="shrink-0 text-warning" />
        <span class="text-[10px] font-semibold text-foreground">
          {analysis.hunks.length} conflict {analysis.hunks.length === 1 ? 'hunk' : 'hunks'} · lines
          {analysis.hunks[0]?.startLine ?? 0}–{analysis.hunks.at(-1)?.endLine ?? 0}
        </span>
        <span class="flex-1"></span>
        <span class="text-[9px] text-dimmed">
          {analysis.hunks.filter((_, index) => typeof resolutions[index] === 'string').length}/
          {analysis.hunks.length}
          resolved
        </span>
      </div>
      <div class="flex-1 space-y-3 p-3">
        {#each analysis.hunks as hunk, index (index)}
          {@const resolution = resolutions[index] ?? null}
          {@const resolved = typeof resolution === 'string'}
          <section
            class="overflow-hidden rounded-xl border {resolved
              ? 'border-success/30'
              : 'border-warning/30'} bg-surface"
          >
            <div class="flex items-center gap-2 border-b border-border bg-elevated/40 px-3 py-1.5">
              <GitMerge size={12} class="shrink-0 text-warning" />
              <span class="text-[10px] font-semibold text-foreground">Conflict {index + 1}</span>
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
                  <span class="truncate font-mono text-[8px] text-dimmed">{hunk.oursLabel}</span>
                  <span class="flex-1"></span>
                  <button
                    type="button"
                    class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
                    title="Keep the current (ours) side for this conflict"
                    disabled={hunk.ours === resolution}
                    onclick={() => resolveHunk(index, hunk.ours)}
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
                  <span class="truncate font-mono text-[8px] text-dimmed">{hunk.theirsLabel}</span>
                  <span class="flex-1"></span>
                  <button
                    type="button"
                    class="rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
                    title="Accept the incoming (theirs) side for this conflict"
                    disabled={hunk.theirs === resolution}
                    onclick={() => resolveHunk(index, hunk.theirs)}
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
                <span class="shrink-0 text-[9px] font-semibold uppercase tracking-wide text-muted">
                  Result
                </span>
                <button
                  type="button"
                  class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
                  title="Keep both sides, stacked"
                  onclick={() => mergeBoth(index)}
                >
                  Merge both
                </button>
                {#if resolved}
                  <button
                    type="button"
                    class="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
                    title="Clear this conflict back to unresolved"
                    onclick={() => clearHunk(index)}
                  >
                    Reset
                  </button>
                {/if}
              </div>
              <textarea
                class="mt-1.5 h-24 w-full resize-none rounded-md border border-border bg-app px-2.5 py-2 font-mono text-[10px] leading-5 text-foreground outline-none placeholder:text-dimmed focus:border-primary"
                placeholder="Choose a side above, merge both, or type your own resolution…"
                value={resolution ?? ''}
                oninput={(event) => resolveHunk(index, event.currentTarget.value)}></textarea>
            </div>
          </section>
        {/each}

        {#if saveError}
          <p
            class="rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-[10px] leading-relaxed text-danger"
          >
            {saveError}
          </p>
        {/if}
      </div>

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
