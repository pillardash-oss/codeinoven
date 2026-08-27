<script lang="ts">
  import {
    BookOpenText,
    CheckCircle2,
    ChevronRight,
    Clock,
    FilePenLine,
    FilePlus2,
    Globe2,
    Loader2,
    Search,
    Terminal,
    Wrench,
    XCircle
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import type { AgentPart } from '$shared/types'
  import InlineToolDiff from './InlineToolDiff.svelte'
  import {
    checkpointPathsForTool,
    checkpointToolDiff,
    toolFileDiffs,
    type ToolFileDiff
  } from './tool-diff'

  interface Props {
    part: Extract<AgentPart, { type: 'tool' }>
    projectId?: string
    threadId?: string
    checkpointId?: string | null
    checkpointPaths?: string[]
  }

  let { part, projectId, threadId, checkpointId = null, checkpointPaths = [] }: Props = $props()

  let open = $state(false)
  let userToggled = $state(false)
  let elapsed = $state(0)
  let checkpointDiffs = $state<ToolFileDiff[]>([])
  let loadedCheckpointKey = $state<string | null>(null)

  let start = $derived(part.state.time?.start)
  let end = $derived(part.state.time?.end)
  let isRunning = $derived(part.state.status === 'running')
  const fileDiffs = $derived(toolFileDiffs(part))
  const displayDiffs = $derived(fileDiffs.length > 0 ? fileDiffs : checkpointDiffs)

  $effect(() => {
    if (displayDiffs.length > 0 && !userToggled) open = true
  })

  $effect(() => {
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
    if (start && end) {
      // Completed: the duration is a frozen snapshot of the call itself.
      elapsed = Math.floor((end - start) / 1000)
    } else if (start && isRunning) {
      const interval = setInterval(() => {
        elapsed = Math.floor((Date.now() - start) / 1000)
      }, 1000)
      return () => clearInterval(interval)
    } else if (start && elapsed === 0) {
      // Terminal state without an end timestamp (e.g. an interrupted run):
      // snapshot once, then never re-derive from the wall clock, or the card
      // would keep counting while the agent moves on to other tools.
      elapsed = Math.floor((Date.now() - start) / 1000)
    }
  })

  const statusMeta = $derived.by(() => {
    switch (part.state.status) {
      case 'running':
        return { icon: Loader2, class: 'text-info animate-spin' }
      case 'completed':
        return { icon: CheckCircle2, class: 'text-success' }
      case 'error':
        return { icon: XCircle, class: 'text-danger' }
      default:
        return { icon: Clock, class: 'text-dimmed' }
    }
  })

  const inputPreview = $derived(formatInput(part.state.input))
  const toolKind = $derived.by(() => {
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

  function formatInput(input: Record<string, unknown>): string {
    const entries = Object.entries(input)
    if (entries.length === 0) return ''
    const first = entries[0]
    const value = typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1])
    const preview = value.length > 80 ? `${value.slice(0, 80)}…` : value
    return `${first[0]}: ${preview}`
  }

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }
</script>

<div class="overflow-hidden rounded-lg border bg-surface">
  <button
    type="button"
    class="flex w-full items-center gap-2 overflow-x-auto overflow-y-hidden px-3 py-2 text-left transition-colors hover:bg-elevated"
    aria-expanded={open}
    title={open ? 'Hide tool details' : 'Show tool details'}
    onclick={() => {
      open = !open
      userToggled = true
    }}
  >
    {#if statusMeta.icon === Loader2}
      <Loader2 size={14} class="shrink-0 {statusMeta.class}" />
    {:else if statusMeta.icon === CheckCircle2}
      <CheckCircle2 size={14} class="shrink-0 {statusMeta.class}" />
    {:else if statusMeta.icon === XCircle}
      <XCircle size={14} class="shrink-0 {statusMeta.class}" />
    {:else}
      <Clock size={14} class="shrink-0 {statusMeta.class}" />
    {/if}
    {#if toolKind === 'read'}
      <BookOpenText size={12} class="shrink-0 text-dimmed" />
    {:else if toolKind === 'edit'}
      <FilePenLine size={12} class="shrink-0 text-dimmed" />
    {:else if toolKind === 'write'}
      <FilePlus2 size={12} class="shrink-0 text-dimmed" />
    {:else if toolKind === 'search'}
      <Search size={12} class="shrink-0 text-dimmed" />
    {:else if toolKind === 'web'}
      <Globe2 size={12} class="shrink-0 text-dimmed" />
    {:else if toolKind === 'shell'}
      <Terminal size={12} class="shrink-0 text-dimmed" />
    {:else}
      <Wrench size={12} class="shrink-0 text-dimmed" />
    {/if}
    <span class="shrink-0 font-mono text-xs font-medium text-foreground">
      {part.state.title ?? part.tool}
    </span>
    {#if start}
      <span class="tabular-nums text-[10px] text-dimmed">{formatDuration(elapsed)}</span>
    {/if}
    {#if !open && inputPreview}
      <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-dimmed">{inputPreview}</span>
    {:else}
      <span class="flex-1"></span>
    {/if}
    <ChevronRight
      size={13}
      class="shrink-0 text-dimmed transition-transform {open ? 'rotate-90' : ''}"
    />
  </button>

  {#if open}
    <div class="space-y-2 border-t px-3 py-2">
      {#if displayDiffs.length > 0}
        <InlineToolDiff diffs={displayDiffs} />
      {:else if Object.keys(part.state.input).length > 0}
        <div>
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-dimmed">Input</p>
          <pre
            class="max-h-40 overflow-auto rounded-md bg-elevated p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">{JSON.stringify(
              part.state.input,
              null,
              2
            )}</pre>
        </div>
      {/if}
      {#if displayDiffs.length === 0 && part.state.output}
        <div>
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-dimmed">Output</p>
          <pre
            class="max-h-40 overflow-auto rounded-md bg-elevated p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-foreground">{part
              .state.output}</pre>
        </div>
      {/if}
      {#if part.state.error}
        <div>
          <p class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-dimmed">Error</p>
          <pre
            class="max-h-40 overflow-auto rounded-md bg-danger/5 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-danger">{part
              .state.error}</pre>
        </div>
      {/if}
    </div>
  {/if}
</div>
