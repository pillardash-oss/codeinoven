<script lang="ts">
  import { onMount } from 'svelte'
  import { Eye, FileCode2, FolderOpen, Loader2, RotateCw } from '@lucide/svelte'

  import { documentPreviewFrame, htmlPreviewFrame } from '$lib/document-preview-frame'
  import { standaloneFilePreviewUrl } from '$lib/file-preview'
  import { invoke } from '$lib/ipc.svelte'
  import {
    isAudioMime,
    isDocumentPreviewPath,
    isHtmlPreviewPath,
    isImageMime,
    isPdfMime,
    isSvgMime,
    isVideoMime,
    mimeFromPath,
    supportsFilePreview
  } from '$lib/mime'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import type { ProjectTextFile } from '$shared/types'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import FileImagePreview from './FileImagePreview.svelte'
  import FileMediaPreview from './FileMediaPreview.svelte'
  import ProjectTextEditor from './ProjectTextEditor.svelte'

  interface Props {
    /** Absolute path of the file the operating system handed over. */
    path: string
    /** Display name (the basename main resolved). */
    name: string
  }

  let { path, name }: Props = $props()

  type View = 'source' | 'preview'

  const mime = $derived(mimeFromPath(name || path))
  const image = $derived(isImageMime(mime))
  const svg = $derived(isSvgMime(mime))
  const video = $derived(isVideoMime(mime))
  const audio = $derived(isAudioMime(mime))
  const pdf = $derived(isPdfMime(mime))
  const markdown = $derived(/\.(?:md|mdown|markdown)$/iu.test(name || path))
  const htmlPreview = $derived(isHtmlPreviewPath(path))
  const documentPreview = $derived(isDocumentPreviewPath(path))
  const previewable = $derived(supportsFilePreview(path))
  /** Kinds rendered from bytes rather than text; their content never has to
   *  cross IPC because the preview protocol streams it to the element. */
  const binaryPreview = $derived(pdf || image || documentPreview)

  /** Rendered kinds default to preview (like the project editor does); text and
   *  code default to the read-only source view. `view` stays null until the
   *  user picks explicitly, so the default keeps following the file (the pane
   *  is re-created per file) without an effect resetting it. */
  let view = $state<View | null>(null)
  const defaultView = $derived<View>(binaryPreview ? 'preview' : 'source')
  const activeView = $derived<View>(view ?? defaultView)
  let reloadToken = $state(0)
  let source = $state<ProjectTextFile | null>(null)
  let loading = $state(false)
  let loadError = $state<string | null>(null)
  let svgUrl = $state<string | null>(null)
  let documentHtml = $state<string | null>(null)
  let documentLoading = $state(false)
  let documentError = $state<string | null>(null)
  /** Guards against a slow read landing after the pane was replaced. */
  let requestSequence = 0

  const previewUrl = $derived(
    pdf || video || audio || (image && !svg)
      ? standaloneFilePreviewUrl(path, name || path, reloadToken)
      : null
  )
  const htmlSrcdoc = $derived(htmlPreview && source ? htmlPreviewFrame(source.content) : null)

  /** SVG is rendered from a blob URL: the privileged `appfile://` scheme refuses
   *  to serve SVG, so program-controlled active XML never runs in a
   *  custom-scheme document. */
  function applySource(file: ProjectTextFile | null): void {
    if (svgUrl) {
      URL.revokeObjectURL(svgUrl)
      svgUrl = null
    }
    source = file
    if (svg && file) {
      svgUrl = URL.createObjectURL(new Blob([file.content], { type: 'image/svg+xml' }))
    }
  }

  async function loadSource(): Promise<void> {
    if (binaryPreview) {
      applySource(null)
      loadError = null
      loading = false
      return
    }
    const sequence = ++requestSequence
    loading = true
    loadError = null
    try {
      const file = await invoke('file:readText', path)
      if (sequence !== requestSequence) return
      applySource(file)
      loadError = file === null ? 'This file cannot be displayed as text' : null
    } catch (error) {
      if (sequence !== requestSequence) return
      applySource(null)
      loadError = error instanceof Error ? error.message : String(error)
    } finally {
      if (sequence === requestSequence) loading = false
    }
  }

  /** Office/CSV documents are converted to sanitized HTML by main. */
  async function loadDocument(): Promise<void> {
    if (!documentPreview) return
    const sequence = ++requestSequence
    documentLoading = true
    documentHtml = null
    documentError = null
    try {
      const html = await invoke('file:readDocumentPreview', path)
      if (sequence !== requestSequence) return
      documentHtml = html ? documentPreviewFrame(html) : null
      documentError = html ? null : 'The document could not be converted for preview'
    } catch (error) {
      if (sequence !== requestSequence) return
      documentError = error instanceof Error ? error.message : String(error)
    } finally {
      if (sequence === requestSequence) documentLoading = false
    }
  }

  onMount(() => {
    void loadSource()
    void loadDocument()
    return () => {
      requestSequence += 1
      applySource(null)
    }
  })

  function reload(): void {
    reloadToken += 1
    void loadSource()
    void loadDocument()
  }

  async function revealInFileManager(): Promise<void> {
    try {
      await invoke('shell:revealPath', path)
    } catch (error) {
      reportError(error, 'The file could not be revealed')
    }
  }
</script>

<div class="flex h-8 shrink-0 items-center gap-0.5 border-b border-border px-2">
  <button
    type="button"
    class={[
      'flex h-6 w-6 items-center justify-center rounded transition-colors',
      activeView === 'source'
        ? 'bg-overlay text-foreground'
        : 'text-dimmed hover:bg-elevated hover:text-foreground'
    ]}
    aria-label="Show file source"
    aria-pressed={activeView === 'source'}
    title="Source"
    onclick={() => (view = 'source')}
  >
    <FileCode2 size={12} />
  </button>
  {#if previewable}
    <button
      type="button"
      class={[
        'flex h-6 w-6 items-center justify-center rounded transition-colors',
        activeView === 'preview'
          ? 'bg-overlay text-foreground'
          : 'text-dimmed hover:bg-elevated hover:text-foreground'
      ]}
      aria-label={`Preview ${name}`}
      aria-pressed={activeView === 'preview'}
      title="Preview"
      onclick={() => (view = 'preview')}
    >
      <Eye size={12} />
    </button>
  {/if}
  <button
    type="button"
    class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
    aria-label="Reload the file"
    title="Reload"
    disabled={loading}
    onclick={reload}
  >
    <RotateCw size={12} />
  </button>
  <button
    type="button"
    class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Show in file manager"
    title="Show in file manager"
    onclick={() => void revealInFileManager()}
  >
    <FolderOpen size={12} />
  </button>
  <span class="ml-1 truncate text-[0.625rem] text-dimmed" title={path}>{path}</span>
</div>

{#if loading}
  <div
    class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed"
    role="status"
  >
    <Loader2 size={13} class="animate-spin" />
    Loading file
  </div>
{:else if activeView === 'preview' && markdown && source}
  <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
    <MarkdownView text={source.content} class="text-sm text-foreground" />
  </div>
{:else if activeView === 'preview' && htmlPreview && htmlSrcdoc}
  <div class="min-h-0 flex-1 bg-surface">
    <iframe srcdoc={htmlSrcdoc} sandbox="" class="h-full w-full border-0" title={`Preview ${name}`}
    ></iframe>
  </div>
{:else if activeView === 'preview' && pdf && previewUrl}
  <div class="min-h-0 flex-1 overflow-auto">
    <iframe src={previewUrl} class="h-full w-full border-0" title={`Preview ${name}`}></iframe>
  </div>
{:else if activeView === 'preview' && documentPreview}
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
        title={`Preview ${name}`}
      ></iframe>
    {:else if documentError}
      <div class="flex h-full flex-col items-center justify-center gap-2 text-dimmed" role="status">
        <span class="text-xs">This document could not be previewed</span>
        <span class="max-w-md text-center text-[0.625rem] break-words text-danger">
          {documentError}
        </span>
      </div>
    {/if}
  </div>
{:else if activeView === 'preview' && image}
  <FileImagePreview src={svg ? svgUrl : previewUrl} alt={name} />
{:else if activeView === 'preview' && (video || audio)}
  <FileMediaPreview src={previewUrl} alt={name} kind={video ? 'video' : 'audio'} />
{:else if source}
  <ProjectTextEditor
    value={source.content}
    {path}
    readonly
    ariaLabel={`View ${name}`}
    onInput={() => undefined}
  />
{:else}
  <div class="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6">
    <div class="text-center">
      <p class="text-xs font-medium text-dimmed">This file cannot be viewed here</p>
      <p class="mt-1 text-[0.625rem] text-dimmed">
        {loadError ?? 'Open it with your editor instead.'}
      </p>
    </div>
    <button
      type="button"
      class="rounded border border-border bg-elevated px-3 py-1.5 text-[0.625rem] font-medium text-muted hover:text-foreground"
      onclick={() => void revealInFileManager()}
    >
      Show in file manager
    </button>
  </div>
{/if}
