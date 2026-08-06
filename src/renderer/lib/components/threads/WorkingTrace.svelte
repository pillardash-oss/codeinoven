<script lang="ts">
  import { Archive, Bot, Cog, FileText, Loader2, Zap } from '@lucide/svelte'
  import { onDestroy } from 'svelte'
  import ToolCard from './ToolCard.svelte'
  import SubagentCard from './SubagentCard.svelte'
  import ThinkingBlock from './ThinkingBlock.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import type { AgentPart } from '$shared/types'
  import { isImageMime } from '$lib/mime'
  import { FileBlobUrlManager } from '$lib/media-urls.svelte'

  interface Props {
    parts: AgentPart[]
    open?: boolean
    busy?: boolean
    latest?: boolean
    initialOpen?: boolean
    initialUserOpened?: boolean
    /** When the agent started working on this trace; used to show a live duration. */
    startTime?: number
    /** Attribution for the model currently working on this trace. */
    modelLabel?: string | null
    providerName?: string | null
    harnessId?: string | null
    harnessName?: string | null
    isFast?: boolean
    projectId?: string
    threadId?: string
    checkpointId?: string | null
    checkpointPaths?: string[]
    onToggle?: (open: boolean, userOpened: boolean) => void
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
    onCiteFile?: (path: string, line?: number) => void
  }

  let {
    parts,
    open = false,
    busy = false,
    latest = false,
    initialOpen = false,
    initialUserOpened = false,
    startTime,
    modelLabel = null,
    providerName,
    harnessId,
    harnessName,
    isFast = false,
    projectId,
    threadId,
    checkpointId = null,
    checkpointPaths = [],
    onToggle,
    onOpenSubagent,
    onCiteFile
  }: Props = $props()

  // Intentional initial-value capture — props are only used to seed local state.
  // svelte-ignore state_referenced_locally
  let isOpen = $state(open || initialOpen)
  // svelte-ignore state_referenced_locally
  let userOpened = $state(initialUserOpened)
  // svelte-ignore state_referenced_locally
  let wasBusy = $state(busy)
  // svelte-ignore state_referenced_locally
  let wasLatest = $state(latest)
  let closeTimer: ReturnType<typeof setTimeout> | null = null
  let imageUrls = new FileBlobUrlManager()
  let elapsed = $state(0)

  // When no explicit start is available, fall back to the earliest working
  // part timestamp so the timer keeps counting even at message boundaries.
  const effectiveStartTime = $derived.by((): number | undefined => {
    if (startTime && startTime > 0) return startTime
    for (const part of parts) {
      const start =
        part.type === 'tool'
          ? part.state.time?.start
          : part.type === 'reasoning'
            ? part.time?.start
            : part.type === 'subagent'
              ? part.activity.time?.start
              : undefined
      if (start && start > 0) return start
    }
    return undefined
  })

  // Live count of how long the agent has been working. Ticks every second
  // while the trace is busy; only rendered beside the busy indicator.
  $effect(() => {
    if (!busy || !effectiveStartTime) {
      elapsed = 0
      return
    }
    elapsed = Math.max(0, Math.floor((Date.now() - effectiveStartTime) / 1000))
    const interval = setInterval(() => {
      elapsed = Math.max(0, Math.floor((Date.now() - effectiveStartTime) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  })

  function formatDuration(seconds: number): string {
    if (seconds < 60) return `${seconds}s`
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
    const s = seconds % 60
    return s > 0 ? `${m}m ${s}s` : `${m}m`
  }

  // Convert file:// image URLs to blob: Object URLs so attached images render
  // reliably in the Electron renderer.
  $effect(() => {
    for (const part of parts) {
      if (part.type === 'file' && isImageMime(part.mime) && part.url.startsWith('file://')) {
        void imageUrls.load(part.url, part.mime)
      }
    }
  })

  onDestroy(() => imageUrls.destroy())

  function notify(): void {
    onToggle?.(isOpen, userOpened)
  }

  $effect(() => {
    if (busy && parts.length > 0) {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      if (!isOpen) {
        isOpen = true
        notify()
      }
    } else if (wasLatest && !latest && isOpen && !userOpened) {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      isOpen = false
      notify()
    } else if (wasBusy && !busy && isOpen && !userOpened) {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
      closeTimer = setTimeout(() => {
        isOpen = false
        closeTimer = null
        notify()
      }, 2000)
    }
    wasBusy = busy
    wasLatest = latest
  })

  $effect(() => {
    return () => {
      if (closeTimer) clearTimeout(closeTimer)
    }
  })

  function onSummaryClick(event: MouseEvent): void {
    event.preventDefault()
    isOpen = !isOpen
    userOpened = isOpen
    if (closeTimer) {
      clearTimeout(closeTimer)
      closeTimer = null
    }
    notify()
  }

  let lastReasoningId = $derived.by((): string | null => {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].type === 'reasoning') return parts[i].id
    }
    return null
  })
  const subagentCount = $derived(parts.filter((part) => part.type === 'subagent').length)
  const activeSubagentCount = $derived(
    parts.filter((part) => part.type === 'subagent' && part.activity.status === 'running').length
  )
  const hasCompaction = $derived(
    parts.some((part) => part.type === 'compaction' || part.type === 'compaction-summary')
  )
</script>

<details class="rounded-xl border border-border bg-surface" open={isOpen}>
  <summary
    class="flex cursor-pointer items-center gap-2 px-3 py-2.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
    onclick={onSummaryClick}
  >
    {#if isOpen && busy}
      <Loader2 size={12} class="shrink-0 animate-spin text-info" />
    {:else}
      <Cog size={12} class="shrink-0" />
    {/if}
    Working Trace
    <span class="tabular-nums text-dimmed">({parts.length})</span>
    {#if hasCompaction || subagentCount > 0}
      <span class="ml-auto flex items-center gap-1.5">
        {#if hasCompaction}
          <span
            class="flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[9px] text-info"
            title="This trace includes compacted context. Forking from here restores the compaction summary."
            aria-label="Compacted context. Forking from here restores the compaction summary."
          >
            <Archive size={10} />
            Compacted
          </span>
        {/if}
        {#if subagentCount > 0}
          <span
            class="flex items-center gap-1 rounded-md bg-info/10 px-1.5 py-0.5 text-[9px] text-info"
          >
            <Bot size={10} />
            {#if activeSubagentCount > 0}
              {activeSubagentCount} active · {subagentCount} total
            {:else}
              {subagentCount} {subagentCount === 1 ? 'sub-agent' : 'sub-agents'}
            {/if}
          </span>
        {/if}
      </span>
    {/if}
  </summary>
  <div class="flex flex-col px-3 pb-3 [&>*:first-child]:mt-2 [&>*+*]:mt-2">
    {#each parts as part (part.id)}
      {#if part.type === 'reasoning'}
        <ThinkingBlock {part} active={busy && part.id === lastReasoningId} {onCiteFile} />
      {:else if part.type === 'tool'}
        <ToolCard {part} {projectId} {threadId} {checkpointId} {checkpointPaths} />
      {:else if part.type === 'subagent'}
        <SubagentCard {part} onOpen={onOpenSubagent} />
      {:else if part.type === 'text'}
        <div class="text-sm text-foreground">
          <MarkdownView text={part.text} {onCiteFile} />
        </div>
      {:else if part.type === 'compaction-summary'}
        <div class="rounded-lg border border-border bg-elevated px-3 py-2">
          <p class="mb-1 text-[11px] font-medium text-foreground">Compaction summary</p>
          <div class="text-sm text-muted">
            <MarkdownView text={part.text} {onCiteFile} />
          </div>
        </div>
      {:else if part.type === 'step-finish'}
        {#if part.reason}
          <span class="text-[10px] text-dimmed">Step complete · {part.reason}</span>
        {/if}
      {:else if part.type === 'compaction'}
        <details class="rounded-lg border border-border bg-elevated">
          <summary
            class="flex cursor-pointer items-center gap-2 px-3 py-2 transition-colors hover:bg-overlay"
          >
            {#if busy && !part.summary}
              <Loader2 size={12} class="shrink-0 animate-spin text-info" />
            {:else}
              <Archive size={12} class="shrink-0 text-info" />
            {/if}
            <div class="min-w-0">
              <p
                class="flex flex-wrap items-center gap-1.5 text-[11px] font-medium text-foreground"
              >
                {part.auto ? 'Automatic compaction' : 'Compact Work'}
                {#if !part.summary && !busy}
                  <span
                    class="rounded-md bg-warning/10 px-1.5 py-0.5 text-[9px] font-normal text-warning"
                    title="The harness completed compaction without producing a summary."
                  >
                    harness returned nothing
                  </span>
                {/if}
              </p>
              <p class="text-[10px] text-dimmed">
                {part.summary
                  ? 'Earlier work summarized'
                  : part.overflow
                    ? 'Context limit reached · summarizing earlier work'
                    : 'Summarizing earlier work to free context'}
              </p>
            </div>
          </summary>
          {#if part.summary}
            <div class="border-t border-border px-3 py-2 text-sm text-muted">
              <MarkdownView text={part.summary} {onCiteFile} />
            </div>
          {/if}
        </details>
      {:else if part.type === 'file'}
        <div class="flex items-center gap-1.5 text-[10px] text-dimmed">
          {#if isImageMime(part.mime)}
            <img
              src={imageUrls.getUrl(part.url)}
              alt={part.filename ?? 'file'}
              class="h-6 w-6 shrink-0 rounded object-cover"
              onerror={(e: Event) =>
                void imageUrls.bindImage(part.url, part.mime, e.currentTarget as HTMLImageElement)}
            />
          {:else}
            <FileText size={10} class="shrink-0" />
          {/if}
          {part.filename ?? part.url.split('/').pop() ?? 'file'}
        </div>
      {/if}
    {/each}
    {#if isOpen && busy}
      <div class="flex items-center gap-2">
        <Loader2 size={11} class="animate-spin text-info" />
        <span class="text-[10px] text-info/80">Agent working…</span>
        {#if effectiveStartTime}
          <span class="tabular-nums text-[10px] text-info/80">
            · {formatDuration(elapsed)}
          </span>
        {/if}
        {#if modelLabel}
          <span class="ml-auto flex min-w-0 items-center gap-1.5 text-[10px] text-dimmed">
            {#if harnessId}
              <span class="flex shrink-0 items-center gap-1">
                <AgentIcon agentId={harnessId} size={14} />
                {#if harnessName}<span class="truncate">{harnessName}</span>{/if}
              </span>
              <span>·</span>
            {/if}
            <span class="flex shrink-0 items-center gap-1">
              <VendorIcon name={providerName ?? modelLabel} size={11} />
              <span class="truncate">{modelLabel}</span>
            </span>
            {#if isFast}
              <Zap
                size={10}
                class="shrink-0 text-accent"
                fill="currentColor"
                aria-label="Fast inference"
                title="Fast inference"
              />
            {/if}
          </span>
        {/if}
      </div>
    {/if}
  </div>
</details>
