<script lang="ts">
  import CioBrowser from '@pdslng/cio-icon/CioBrowser.svelte'
  import CioCode from '@pdslng/cio-icon/CioCode.svelte'
  import CioCrossCircle from '@pdslng/cio-icon/CioCrossCircle.svelte'
  import CioFilePen from '@pdslng/cio-icon/CioFilePen.svelte'
  import CioFilePlus from '@pdslng/cio-icon/CioFilePlus.svelte'
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioForward from '@pdslng/cio-icon/CioForward.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
  import CioWrench from '@pdslng/cio-icon/CioWrench.svelte'
  import CioMonogram from '$lib/components/icons/cio/CioMonogram.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { invoke } from '$lib/ipc.svelte'
  import { slide } from 'svelte/transition'
  import { foldSlide } from '$lib/components/shared/card-motion'
  import { isCioToolName, isCodeModeToolName } from '$shared/agent-interactions'
  import { isOpaqueId } from '$shared/tool-action-label'
  import type { AgentPart } from '$shared/types'
  import { ElapsedTimer } from '$lib/elapsed.svelte'
  import { formatDurationMs } from '$lib/format/duration'
  import LongTextBlock from '../markdown/LongTextBlock.svelte'
  import InlineToolDiff from './InlineToolDiff.svelte'
  import {
    checkpointPathsForTool,
    checkpointToolDiff,
    toolFileDiffs,
    type ToolFileDiff
  } from './tool-diff'

  interface Props {
    part: Extract<AgentPart, { type: 'tool' }>
    /** True only while a live session is streaming this call. Historical or
     *  restored traces must never tick   their durations are frozen snapshots. */
    live?: boolean
    projectId?: string
    threadId?: string
    checkpointId?: string | null
    checkpointPaths?: string[]
  }

  let {
    part,
    live = false,
    projectId,
    threadId,
    checkpointId = null,
    checkpointPaths = []
  }: Props = $props()

  let open = $state(false)
  const clock = new ElapsedTimer()
  let checkpointDiffs = $state<ToolFileDiff[]>([])
  let loadedCheckpointKey = $state<string | null>(null)

  let start = $derived(part.state.time?.start)
  let end = $derived(part.state.time?.end)
  let isRunning = $derived(part.state.status === 'running')
  const fileDiffs = $derived(toolFileDiffs(part))
  const displayDiffs = $derived(fileDiffs.length > 0 ? fileDiffs : checkpointDiffs)

  $effect(() => {
    // Nothing is read until the reader opens the card: a trace can mount
    // hundreds of folded rows, and each diff read is an IPC round trip.
    if (!open) return
    const paths = checkpointPathsForTool(part, checkpointPaths)
    const currentProjectId = projectId
    const currentThreadId = threadId
    const currentCheckpointId = checkpointId
    if (
      !currentProjectId ||
      !currentThreadId ||
      !currentCheckpointId ||
      paths.length === 0 ||
      fileDiffs.length > 0
    ) {
      return
    }
    const key = `${currentProjectId}:${currentThreadId}:${currentCheckpointId}:${paths.join('\0')}`
    if (loadedCheckpointKey === key) return
    loadedCheckpointKey = key
    checkpointDiffs = []
    let cancelled = false
    void Promise.allSettled(
      paths.map((path) =>
        invoke('checkpoint:diff', currentProjectId, currentThreadId, currentCheckpointId, path)
      )
    ).then((results) => {
      if (cancelled) return
      checkpointDiffs = results
        .flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
        .map(checkpointToolDiff)
        .filter((diff): diff is ToolFileDiff => diff !== null)
    })
    return () => {
      cancelled = true
    }
  })

  $effect(() => {
    if (start && isRunning && live) clock.start()
    else {
      clock.stop()
      // Terminal, or a restored run with no end timestamp: pin one snapshot
      // instead of letting the card keep counting on later re-renders.
      if (start && !end) clock.snapshot()
    }
    return () => clock.stop()
  })

  const elapsed = $derived(clock.seconds(start, end))

  /**
   * A running call says so with a glow travelling along its whole line, so it
   * wears no spinner; a settled call wears no tick either, because the glow
   * leaving the row is the completion. Only a failure keeps a mark.
   *
   * A restored trace is never live, so a call the process was cut off inside
   * stays quiet instead of glowing forever.
   */
  const working = $derived(
    live && (part.state.status === 'running' || part.state.status === 'pending')
  )
  const failed = $derived(part.state.status === 'error')

  const inputPreview = $derived(formatInput(part.state.input))
  /** The tool-kind glyph: washed out with the row, brighter on hover. */
  const kindIconClass = 'shrink-0 text-dimmed transition-colors group-hover/tool:text-muted'
  const toolKind = $derived.by(() => {
    // The app's own gateway tools outrank every heuristic: their names are the
    // app's own vocabulary (`cio_util_use`, `cio_todo_write`), so the words in
    // them must not be read as the tool's subject. `cio_todo_write` is not a
    // file write, and the reader should see the app's mark on the call rather
    // than a glyph that says otherwise.
    if (isCioToolName(part.tool)) return 'cio'
    // Code mode outranks the name heuristics: a call a script made can carry
    // any inner tool name (read, bash, an MCP call), and it belongs to the
    // code-mode glyph wherever the harness reports it as such.
    if (part.codeMode === true || isCodeModeToolName(part.tool)) return 'code'
    const name = part.tool.toLowerCase().replace(/[-_\s]/g, '')
    if (name.includes('websearch') || name.includes('webfetch')) return 'web'
    if (
      name.includes('search') ||
      name.includes('explore') ||
      name.includes('grep') ||
      name.includes('glob') ||
      name === 'find'
    ) {
      return 'search'
    }
    if (name.includes('read') || name.includes('view')) return 'read'
    if (name.includes('edit') || name.includes('patch') || name.includes('filechange'))
      return 'edit'
    if (name.includes('write') || name.includes('create')) return 'write'
    if (name.includes('bash') || name.includes('shell') || name.includes('terminal')) return 'shell'
    return 'other'
  })

  /** A code-mode call orchestrates other tools by script, so it reads as a
   *  distinct kind of step in the trace instead of an unnamed tool. */
  const codeModeLabel = $derived(
    part.state.title ?? part.actionLabel ?? (toolKind === 'code' ? 'Code mode' : part.tool)
  )

  /** True when the row's label describes the action rather than repeating the
   *  tool's own name, which is what the expanded card spells out. */
  const labeled = $derived(codeModeLabel !== part.tool)

  /** Bound on the collapsed row's input preview. The row truncates to the
   *  width it actually has in CSS, so this only stops a pathological first
   *  argument (a whole file's contents) being copied into a second string on
   *  every render; it is far beyond any width the row can show. */
  const PREVIEW_MAX_CHARS = 2_000

  /**
   * The call's own subject as the collapsed row shows it: the first argument's
   * value behind a colon, with no argument name in front of it.
   *
   * The name is tautology next to the label that already says what the call did
   * (`Shell : bun test`, not `Shell · command: bun test`), and for a call whose
   * first argument repeats the action (`edits: [...]` under an edit row) it made
   * the row say the same word twice. A value that names nothing, such as the
   * opaque row id a `cio_util_use` call carries, is skipped for the first
   * argument a reader can actually use.
   */
  function formatInput(input: Record<string, unknown>): string {
    for (const [, value] of Object.entries(input)) {
      const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '')
      if (!text || (typeof value === 'string' && isOpaqueId(value))) continue
      const preview =
        text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text
      return `: ${preview}`
    }
    return ''
  }

  /** Display-side threshold for giant tool strings. Mirrors the persistence
   *  cap in the main process (64KB head+tail), so every string that reaches
   *  the renderer at full length is a candidate for DOM cost. Below the
   *  threshold the plain <pre> keeps the historical look; above it the
   *  LongTextBlock collapses the run until the user asks for the full text. */
  const GIANT_TOOL_STRING_CHARS = 64 * 1024
  /** LongTextBlock collapse length for tool strings: more context than the
   *  conversational default so terminal-style output stays recognizable. */
  const TOOL_BLOCK_COLLAPSED_CHARS = 4_000

  const inputJson = $derived(
    Object.keys(part.state.input).length > 0 ? JSON.stringify(part.state.input, null, 2) : ''
  )
  const giantOutput = $derived(
    (part.state.output?.length ?? 0) > GIANT_TOOL_STRING_CHARS ? (part.state.output ?? '') : null
  )
  const giantError = $derived(
    (part.state.error?.length ?? 0) > GIANT_TOOL_STRING_CHARS ? (part.state.error ?? '') : null
  )
  const giantInput = $derived(inputJson.length > GIANT_TOOL_STRING_CHARS ? inputJson : null)
</script>

<div class="min-w-0">
  <button
    type="button"
    class="group/tool isolate relative flex w-full items-center gap-1.5 overflow-hidden py-1 text-left text-[0.6875rem] text-dimmed transition-colors hover:text-foreground"
    aria-expanded={open}
    title={open ? 'Hide tool details' : 'Show tool details'}
    onclick={() => {
      open = !open
    }}
  >
    {#if working}
      <span class="working-row-glow -z-10" aria-hidden="true"></span>
      <span class="sr-only">Running</span>
    {:else if failed}
      <CioCrossCircle size={14} class="shrink-0 text-danger" />
      <span class="sr-only">Failed</span>
    {/if}
    {#if toolKind === 'cio'}
      <CioMonogram size={12} class={kindIconClass} />
    {:else if toolKind === 'code'}
      <CioCode size={12} class={kindIconClass} />
    {:else if toolKind === 'read'}
      <CioFileText size={12} class={kindIconClass} />
    {:else if toolKind === 'edit'}
      <CioFilePen size={12} class={kindIconClass} />
    {:else if toolKind === 'write'}
      <CioFilePlus size={12} class={kindIconClass} />
    {:else if toolKind === 'search'}
      <CioSearch size={12} class={kindIconClass} />
    {:else if toolKind === 'web'}
      <CioBrowser size={ICON_SIZE.inline} class={kindIconClass} />
    {:else if toolKind === 'shell'}
      <CioTerminal size={12} class={kindIconClass} />
    {:else}
      <CioWrench size={12} class={kindIconClass} />
    {/if}
    <span class="shrink-0 font-medium">
      {codeModeLabel}
    </span>
    {#if start}
      <span
        class="tabular-nums text-[0.625rem] text-dimmed transition-colors group-hover/tool:text-muted"
        >{formatDurationMs(elapsed * 1000)}</span
      >
    {/if}
    {#if !open && inputPreview}
      <span
        class="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-dimmed transition-colors group-hover/tool:text-muted"
        >{inputPreview}</span
      >
    {:else}
      <span class="flex-1"></span>
    {/if}
    <CioForward
      size={13}
      class="shrink-0 text-dimmed transition-transform group-hover/tool:text-foreground {open
        ? 'rotate-90'
        : ''}"
    />
  </button>

  {#if open}
    <div transition:slide={foldSlide()} class="space-y-2 border-l border-border/60 py-1 pr-3 pl-3">
      {#if labeled}
        <p class="text-[0.625rem] text-dimmed">
          Tool · <span class="font-mono text-muted">{part.tool}</span>
        </p>
      {/if}
      {#if displayDiffs.length > 0}
        <InlineToolDiff diffs={displayDiffs} />
      {:else if giantInput !== null}
        <div>
          <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
            Input
          </p>
          <LongTextBlock text={giantInput} collapsedChars={TOOL_BLOCK_COLLAPSED_CHARS} />
        </div>
      {:else if Object.keys(part.state.input).length > 0}
        <div>
          <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
            Input
          </p>
          <pre
            class="max-h-40 overflow-auto bg-elevated p-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-muted">{inputJson}</pre>
        </div>
      {/if}
      {#if displayDiffs.length === 0 && part.state.output}
        <div>
          <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
            Output
          </p>
          {#if giantOutput !== null}
            <LongTextBlock text={giantOutput} collapsedChars={TOOL_BLOCK_COLLAPSED_CHARS} />
          {:else}
            <pre
              class="max-h-40 overflow-auto bg-elevated p-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-foreground">{part
                .state.output}</pre>
          {/if}
        </div>
      {/if}
      {#if part.state.error}
        <div>
          <p class="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
            Error
          </p>
          {#if giantError !== null}
            <LongTextBlock text={giantError} collapsedChars={TOOL_BLOCK_COLLAPSED_CHARS} />
          {:else}
            <pre
              class="max-h-40 overflow-auto bg-danger/5 p-2 font-mono text-[0.6875rem] leading-relaxed whitespace-pre-wrap text-danger">{part
                .state.error}</pre>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>
