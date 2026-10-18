<script lang="ts">
  import CioArchive from '@codeio/icon/CioArchive.svelte'
  import CioFileText from '@codeio/icon/CioFileText.svelte'
  import CioForward from '@codeio/icon/CioForward.svelte'
  import CioSpinner from '@codeio/icon/CioSpinner.svelte'
  import { slide } from 'svelte/transition'
  import { foldSlide } from '$lib/components/shared/card-motion'
  import { isImageMime } from '$lib/mime'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import type { AgentPart } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import SubagentCard from './SubagentCard.svelte'
  import ThinkingBlock from './ThinkingBlock.svelte'
  import ToolCard from './ToolCard.svelte'

  interface Props {
    part: AgentPart
    /** True while this trace's turn is still streaming. */
    busy: boolean
    /** True only while a live session is streaming, never for restored traces. */
    live: boolean
    /** The newest reasoning entry, which shows the active thinking state. */
    lastReasoningId: string | null
    imageUrls: FileBlobUrlManager
    onCiteFile?: (path: string, line?: number) => void
    projectId?: string
    threadId?: string
    checkpointId?: string | null
    checkpointPaths?: string[]
    onOpenSubagent?: (part: Extract<AgentPart, { type: 'subagent' }>) => void
  }

  let {
    part,
    busy,
    live,
    lastReasoningId,
    imageUrls,
    onCiteFile,
    projectId,
    threadId,
    checkpointId,
    checkpointPaths,
    onOpenSubagent
  }: Props = $props()

  /** Expansion state of the compaction disclosure, which is not a chain step. */
  let compactionOpen = $state(false)
</script>

{#if part.type === 'reasoning'}
  <ThinkingBlock {part} active={busy && part.id === lastReasoningId} {live} {onCiteFile} />
{:else if part.type === 'tool'}
  <ToolCard {part} {live} {projectId} {threadId} {checkpointId} {checkpointPaths} />
{:else if part.type === 'subagent'}
  <SubagentCard {part} {live} onOpen={onOpenSubagent} />
{:else if part.type === 'compaction-summary'}
  <div class="border border-border bg-elevated px-3 py-2">
    <p class="mb-1 text-[0.6875rem] font-medium text-foreground">Compaction summary</p>
    <div class="text-sm text-muted">
      <MarkdownView text={part.text} {onCiteFile} />
    </div>
  </div>
{:else if part.type === 'step-finish'}
  {#if part.reason}
    <span class="text-[0.625rem] text-dimmed">Step complete · {part.reason}</span>
  {/if}
{:else if part.type === 'compaction'}
  <div class="border border-border bg-elevated">
    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-overlay"
      aria-expanded={compactionOpen}
      title={compactionOpen ? 'Hide compaction summary' : 'Show compaction summary'}
      onclick={() => (compactionOpen = !compactionOpen)}
    >
      {#if busy && !part.summary}
        <CioSpinner size={12} class="shrink-0 animate-spin text-info" />
      {:else}
        <CioArchive size={12} class="shrink-0 text-dimmed" />
      {/if}
      <div class="min-w-0 flex-1">
        <p class="flex flex-wrap items-center gap-1.5 text-[0.6875rem] font-medium text-foreground">
          {part.auto ? 'Automatic compaction' : 'Compact Work'}
          {#if !part.summary && !busy}
            <span
              class="border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-warning uppercase"
              title="The harness completed compaction without producing a summary."
            >
              harness returned nothing
            </span>
          {/if}
        </p>
        <p class="text-[0.625rem] text-dimmed">
          {part.summary
            ? 'Earlier work summarized'
            : part.overflow
              ? 'Context limit reached · summarizing earlier work'
              : 'Summarizing earlier work to free context'}
        </p>
      </div>
      <CioForward
        size={12}
        class="shrink-0 text-dimmed transition-transform {compactionOpen ? 'rotate-90' : ''}"
      />
    </button>
    {#if compactionOpen && part.summary}
      <div
        transition:slide={foldSlide()}
        class="border-t border-border px-3 py-2 text-sm text-muted"
      >
        <MarkdownView text={part.summary} {onCiteFile} />
      </div>
    {/if}
  </div>
{:else if part.type === 'file'}
  <div class="flex items-center gap-1.5 text-[0.625rem] text-dimmed">
    {#if isImageMime(part.mime)}
      <img
        src={imageUrls.getUrl(part.url)}
        alt={part.filename ?? 'file'}
        class="h-6 w-6 shrink-0 object-cover"
        onerror={(e: Event) =>
          void imageUrls.bindImage(part.url, part.mime, e.currentTarget as HTMLImageElement)}
      />
    {:else}
      <CioFileText size={10} class="shrink-0" />
    {/if}
    {part.filename ?? part.url.split('/').pop() ?? 'file'}
  </div>
{/if}
