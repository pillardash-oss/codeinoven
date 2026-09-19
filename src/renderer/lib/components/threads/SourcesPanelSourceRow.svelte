<script lang="ts">
  import { FileText, Globe2, Hash, Image as ImageIcon } from '@lucide/svelte'
  import type {
    AgentSource,
    FileAgentSource,
    FileCitationAgentSource,
    SectionAgentSource
  } from '$lib/agent-sources'
  import type { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { citationDisplayText, isImageSource, sourceLabel } from './sources-panel-helpers'

  interface Props {
    source: AgentSource
    imageUrls: FileBlobUrlManager
    onPreviewImage: (source: FileAgentSource) => void
    onOpenSource: (source: FileAgentSource) => void
    onOpenWeb: (url: string) => void
    onOpenCitation: (source: FileCitationAgentSource) => void
    onOpenSection: (source: SectionAgentSource) => void
  }

  let {
    source,
    imageUrls,
    onPreviewImage,
    onOpenSource,
    onOpenWeb,
    onOpenCitation,
    onOpenSection
  }: Props = $props()
</script>

<div class="group border-b border-border px-4 py-3 transition-colors hover:bg-elevated">
  <div class="flex items-start gap-3">
    {#if source.kind === 'web'}
      {@const favicon = source.url ? faviconState.faviconFor(source.url) : null}
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raised {favicon
          ? ''
          : 'text-muted'}"
      >
        {#if favicon}
          <img src={favicon} alt="" class="h-5 w-5 rounded-sm object-contain" />
        {:else}
          <Globe2 size={15} />
        {/if}
      </span>
    {:else if source.kind === 'file-citation'}
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
      >
        <FileText size={15} />
      </span>
    {:else if source.kind === 'section'}
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
      >
        <Hash size={15} />
      </span>
    {:else if isImageSource(source)}
      <button
        type="button"
        class="h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-lg bg-raised"
        aria-label={`Preview ${source.title}`}
        title={`Preview ${source.title}`}
        onclick={() => onPreviewImage(source)}
      >
        <img
          src={imageUrls.getUrl(source.url)}
          alt=""
          class="h-full w-full object-cover"
          onerror={(e: Event) =>
            void imageUrls.bindImage(source.url, source.mime, e.currentTarget as HTMLImageElement)}
        />
      </button>
    {:else}
      <span
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
      >
        <FileText size={15} />
      </span>
    {/if}

    <div class="min-w-0 flex-1">
      <p class="text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-dimmed">
        {sourceLabel(source)}
      </p>
      {#if source.kind === 'web' && source.url}
        {@const url = source.url}
        <button
          type="button"
          class="mt-0.5 flex min-w-0 cursor-pointer items-center gap-1 text-left text-xs font-medium text-foreground hover:text-primary"
          title={`Open ${url} in browser`}
          onclick={() => onOpenWeb(url)}
        >
          <span class="truncate">{source.title}</span>
        </button>
        <p class="mt-1 truncate text-[0.625rem] text-dimmed" title={url}>
          {url}
        </p>
      {:else if source.kind === 'web'}
        <p class="mt-0.5 text-xs font-medium text-foreground">{source.title}</p>
      {:else if source.kind === 'file-citation'}
        <button
          type="button"
          class="mt-0.5 block max-w-full cursor-pointer text-left text-xs font-medium text-primary hover:text-primary/80"
          title={`Open ${source.path}${source.line ? ` at line ${source.line}` : ''}`}
          onclick={() => onOpenCitation(source)}
        >
          <span class="break-all">{citationDisplayText(source)}</span>
          {#if source.line}
            <span class="ml-1 text-[0.625rem] text-dimmed tabular-nums">:{source.line}</span>
          {/if}
        </button>
      {:else if source.kind === 'section'}
        <button
          type="button"
          class="mt-0.5 block max-w-full cursor-pointer truncate text-left text-xs font-medium text-primary hover:text-primary/80"
          title={`Jump to section ${source.section} in this conversation`}
          onclick={() => onOpenSection(source)}
        >
          <span class="truncate">{source.title}</span>
        </button>
      {:else}
        <button
          type="button"
          class="mt-0.5 block max-w-full cursor-pointer truncate text-left text-xs font-medium text-foreground hover:text-primary"
          title={isImageSource(source) ? `Preview ${source.title}` : `Open ${source.title}`}
          onclick={() => onOpenSource(source)}
        >
          {source.title}
        </button>
      {/if}
      {#if source.kind === 'web' && source.detail}
        <p class="mt-1 line-clamp-2 text-[0.625rem] leading-relaxed text-dimmed">
          {source.detail}
        </p>
      {/if}
    </div>

    {#if source.kind === 'generated-image'}
      <ImageIcon size={13} class="mt-1 shrink-0 text-dimmed" />
    {/if}
  </div>
</div>
