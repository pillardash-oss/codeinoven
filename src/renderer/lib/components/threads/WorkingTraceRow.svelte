<script lang="ts">
  import { Archive, FileText, Loader2 } from '@lucide/svelte'
  import { isImageMime } from '$lib/mime'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import type { AgentPart } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import SmoothMarkdown from '../markdown/SmoothMarkdown.svelte'
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
</script>

{#if part.type === 'reasoning'}
  <ThinkingBlock {part} active={busy && part.id === lastReasoningId} {live} {onCiteFile} />
{:else if part.type === 'tool'}
  <ToolCard {part} {live} {projectId} {threadId} {checkpointId} {checkpointPaths} />
{:else if part.type === 'subagent'}
  <SubagentCard {part} {live} onOpen={onOpenSubagent} />
{:else if part.type === 'text'}
  <div class="text-sm text-foreground">
    <SmoothMarkdown text={part.text} streaming={busy} {onCiteFile} />
  </div>
{:else if part.type === 'compaction-summary'}
  <div class="rounded-lg border border-border bg-elevated px-3 py-2">
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
        <p class="flex flex-wrap items-center gap-1.5 text-[0.6875rem] font-medium text-foreground">
          {part.auto ? 'Automatic compaction' : 'Compact Work'}
          {#if !part.summary && !busy}
            <span
              class="rounded-md bg-warning/10 px-1.5 py-0.5 text-[0.5625rem] font-normal text-warning"
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
    </summary>
    {#if part.summary}
      <div class="border-t border-border px-3 py-2 text-sm text-muted">
        <MarkdownView text={part.summary} {onCiteFile} />
      </div>
    {/if}
  </details>
{:else if part.type === 'file'}
  <div class="flex items-center gap-1.5 text-[0.625rem] text-dimmed">
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
