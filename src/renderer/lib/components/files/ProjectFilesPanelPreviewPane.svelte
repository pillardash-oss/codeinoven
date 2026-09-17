<script lang="ts">
  import { FileQuestion, Loader2 } from '@lucide/svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import FileImagePreview from './FileImagePreview.svelte'
  import FileMediaPreview from './FileMediaPreview.svelte'
  import type { FilePreviewFlags } from './project-files-panel-preview'

  interface Props {
    path: string
    flags: FilePreviewFlags
    visibleContent: string
    htmlPreviewSrcdoc: string | null
    previewUrl: string | null
    imagePreviewSrc: string | null
    imagePreviewFailed: boolean
    documentLoading: boolean
    documentHtml: string | null
    documentFailed: boolean
    documentError: string | null
    showDocumentError: boolean
  }

  let {
    path,
    flags,
    visibleContent,
    htmlPreviewSrcdoc,
    previewUrl,
    imagePreviewSrc,
    imagePreviewFailed,
    documentLoading,
    documentHtml,
    documentFailed,
    documentError,
    showDocumentError
  }: Props = $props()
</script>

{#if flags.markdown}
  <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
    <MarkdownView text={visibleContent} class="text-sm text-foreground" />
  </div>
{:else if flags.html}
  <div class="min-h-0 flex-1 bg-surface">
    {#if htmlPreviewSrcdoc}
      <iframe
        srcdoc={htmlPreviewSrcdoc}
        sandbox=""
        class="h-full w-full border-0"
        title={`Preview ${path}`}
      ></iframe>
    {/if}
  </div>
{:else if flags.pdf}
  <div class="min-h-0 flex-1 overflow-auto">
    {#if previewUrl}
      <iframe src={previewUrl} class="h-full w-full border-0" title={`Preview ${path}`}></iframe>
    {/if}
  </div>
{:else if flags.document}
  <div class="min-h-0 flex-1 overflow-auto bg-surface">
    {#if documentLoading}
      <div class="flex h-full items-center justify-center gap-2 text-dimmed" role="status">
        <Loader2 size={16} class="animate-spin" />
        <span class="sr-only">Loading document preview</span>
      </div>
    {:else if documentHtml}
      <iframe
        srcdoc={documentHtml}
        sandbox=""
        class="h-full w-full border-0"
        title={`Preview ${path}`}
      ></iframe>
    {:else if documentFailed}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-dimmed" role="status">
        <FileQuestion size={24} />
        <span class="text-xs">This document could not be previewed</span>
        {#if showDocumentError && documentError}
          <span class="max-w-md text-center text-[0.625rem] break-words text-danger">
            {documentError}
          </span>
        {/if}
      </div>
    {/if}
  </div>
{:else if flags.image}
  <FileImagePreview src={imagePreviewSrc} alt={path} failed={imagePreviewFailed} />
{:else if flags.video || flags.audio}
  <FileMediaPreview src={previewUrl} alt={path} kind={flags.video ? 'video' : 'audio'} />
{/if}
