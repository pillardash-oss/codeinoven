<script lang="ts">
  import { X, Download, FileQuestion, Loader2, Save, WrapText } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ProjectTextEditor from '../files/ProjectTextEditor.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import { wrapTextState, wrapToggleLabel } from '$lib/stores/wrap-text.svelte'
  import { PanZoom } from '$lib/pan-zoom.svelte'
  import PanZoomToolbar from '../ui/PanZoomToolbar.svelte'
  import type { PromptAttachment } from '$shared/types'
  import { attachmentPreviewKind } from '$lib/mime'
  import { documentPreviewFrame } from '$lib/document-preview-frame'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'

  interface Props {
    attachment: PromptAttachment
    /** blob: URL for image/pdf previews, keyed by the attachment url. */
    src?: string
    /** Decoded text content for markdown/plain-text previews. */
    text?: string
    /** Semantic HTML produced from a document attachment (DOCX, DOC, ODT,
     *  PPTX) in the main process. */
    documentHtml?: string
    documentLoading?: boolean
    /** Persists edits when this is an app-owned pasted-text attachment. */
    onSaveText?: (text: string) => Promise<void>
    onClose: () => void
  }

  let {
    attachment,
    src,
    text,
    documentHtml,
    documentLoading = false,
    onSaveText,
    onClose
  }: Props = $props()

  const filename = $derived(attachment.filename ?? 'file')
  const kind = $derived(attachmentPreviewKind(attachment.mime, filename))
  const editableText = $derived(
    (kind === 'markdown' || kind === 'text') && onSaveText !== undefined
  )
  // The preview is created anew for each selected attachment, so this is the
  // editor's intentional local draft rather than a live mirror of the prop.
  // svelte-ignore state_referenced_locally
  let draft = $state(text ?? '')
  let saving = $state(false)
  let saveError = $state('')
  let confirmCloseOpen = $state(false)
  const dirty = $derived(editableText && draft !== (text ?? ''))
  const documentSrcdoc = $derived(
    kind === 'document' && documentHtml ? documentPreviewFrame(documentHtml) : undefined
  )

  const panZoom = new PanZoom()
  let imageViewport = $state<HTMLDivElement>()
  const imageViewportAttachment = (node: HTMLDivElement): (() => void) => {
    imageViewport = node
    return () => {
      if (imageViewport === node) imageViewport = undefined
    }
  }

  // The component instance is reused if the caller swaps `attachment`
  // without unmounting (same `{#if previewFile}` block)   reset zoom/pan so
  // it doesn't carry over onto the next image.
  $effect(() => {
    void attachment.url
    panZoom.zoom = 1
    panZoom.panX = 0
    panZoom.panY = 0
  })
  const wrapTitle = $derived(wrapToggleLabel(wrapTextState.wrapped))

  function triggerDownload(url: string, name: string): void {
    const link = document.createElement('a')
    link.href = url
    link.download = name
    document.body.appendChild(link)
    link.click()
    link.remove()
  }

  function handleDownload(): void {
    if (kind === 'markdown' || kind === 'text') {
      if (text === undefined) return
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
      triggerDownload(URL.createObjectURL(blob), filename)
      return
    }
    if (src) triggerDownload(src, filename)
  }

  function requestClose(): void {
    if (dirty) {
      confirmCloseOpen = true
      return
    }
    onClose()
  }

  function closeFromButton(event: MouseEvent): void {
    event.stopPropagation()
    requestClose()
  }

  function downloadFromButton(event: MouseEvent): void {
    event.stopPropagation()
    handleDownload()
  }

  async function saveText(): Promise<void> {
    if (!onSaveText || !dirty || saving) return
    saving = true
    saveError = ''
    try {
      await onSaveText(draft)
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'The attachment could not be saved.'
    } finally {
      saving = false
    }
  }
</script>

<svelte:window
  onkeydown={(e: KeyboardEvent) => {
    // Shift is excluded so Cmd/Ctrl+Shift+S stays the right-sidebar toggle.
    if (keymapState.matches('files-save', e) && editableText) {
      e.preventDefault()
      void saveText()
    }
  }}
/>

{#if editableText}
  <Modal
    open
    title={filename}
    description="Full screen attachment editor"
    onClose={requestClose}
    placement="fullscreen"
    chrome={false}
    panelClass="bg-app"
  >
    <div
      class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
      style={trafficLightInsetStyle()}
    >
      <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
        {filename}
      </span>
      {#if saveError}
        <span class="max-w-80 truncate text-[0.625rem] text-danger" role="status">{saveError}</span>
      {/if}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 items-center gap-1 rounded bg-primary px-2 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
        disabled={!dirty || saving}
        title="Save attachment (Cmd/Ctrl+S)"
        onclick={() => void saveText()}
      >
        {#if saving}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <Save size={11} />
        {/if}
        Save
      </button>
      <button
        type="button"
        class={[
          'titlebar-no-drag flex h-7 w-7 items-center justify-center rounded transition-colors hover:bg-elevated hover:text-foreground',
          wrapTextState.wrapped ? 'text-primary' : 'text-dimmed'
        ]}
        aria-label={wrapTitle}
        aria-pressed={wrapTextState.wrapped}
        title={wrapTitle}
        onclick={() => wrapTextState.toggle()}
      >
        <WrapText size={14} />
      </button>
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Download attachment"
        title="Download attachment"
        onclick={handleDownload}
      >
        <Download size={14} />
      </button>
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Close attachment editor"
        title="Close attachment editor (Esc)"
        onclick={requestClose}
      >
        <X size={14} />
      </button>
    </div>
    <ProjectTextEditor
      value={draft}
      path={filename}
      ariaLabel={`Edit ${filename} fullscreen`}
      spellcheck={kind === 'markdown'}
      wrap={wrapTextState.wrapped}
      onInput={({ currentTarget }) => (draft = currentTarget.value)}
    />
  </Modal>
{:else}
  <Modal
    open
    title={`Preview of ${filename}`}
    onClose={requestClose}
    placement="fullscreen"
    chrome={false}
    panelClass="bg-overlay/80 backdrop-blur-sm"
    claimInitialFocus={(panel) => {
      panel.querySelector<HTMLElement>('button')?.focus()
      return true
    }}
  >
    <div
      role="presentation"
      class="relative flex flex-1 items-center justify-center"
      onclick={requestClose}
      onkeydown={(e: KeyboardEvent) => {
        if (keymapState.matches('ui-activate', e)) requestClose()
      }}
    >
      <div
        role="presentation"
        class="relative flex flex-col items-center {kind === 'image'
          ? 'max-h-[90vh] max-w-[90vw]'
          : 'h-[85vh] w-[85vw]'}"
        onclick={(e: MouseEvent) => e.stopPropagation()}
      >
        {#if kind === 'image' && src}
          <div
            {@attach imageViewportAttachment}
            role="group"
            class={[
              'flex touch-none items-center justify-center overflow-hidden',
              panZoom.zoom > 1 && (panZoom.isPanning ? 'cursor-grabbing' : 'cursor-grab')
            ]}
            onwheel={panZoom.onWheel}
            onpointerdown={panZoom.onPointerDown}
            onpointermove={panZoom.onPointerMove}
            onpointerup={panZoom.onPointerUp}
            onpointercancel={panZoom.onPointerUp}
            ondblclick={() => panZoom.reset()}
          >
            <img
              {@attach panZoom.bindTarget}
              {src}
              alt={filename}
              draggable="false"
              class="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
              style={panZoom.transform}
            />
          </div>
          <PanZoomToolbar {panZoom} viewport={imageViewport} class="absolute right-3 bottom-3" />
        {:else if kind === 'video' && src}
          <video
            {src}
            controls
            preload="metadata"
            class="max-h-[75vh] max-w-[85vw] rounded-lg shadow-2xl"
          >
            <track kind="captions" />
          </video>
        {:else if kind === 'audio' && src}
          <audio {src} controls preload="metadata" class="w-full max-w-xl"></audio>
        {:else if kind === 'pdf' && src}
          <iframe
            {src}
            class="h-full w-full rounded-lg border-0 shadow-2xl"
            title={`Preview ${filename}`}
          ></iframe>
        {:else if kind === 'document' && documentSrcdoc}
          <iframe
            srcdoc={documentSrcdoc}
            sandbox=""
            class="h-full w-full rounded-lg border-0 bg-[#eceff1] shadow-2xl"
            title={`Preview ${filename}`}
          ></iframe>
        {:else if kind === 'document' && documentLoading}
          <div
            class="flex h-full w-full items-center justify-center rounded-lg bg-surface text-muted shadow-2xl"
            role="status"
          >
            <Loader2 size={24} class="animate-spin" />
            <span class="sr-only">Loading document preview</span>
          </div>
        {:else if kind === 'markdown' && text !== undefined}
          <div
            class="flex min-h-0 w-full flex-1 flex-col overflow-auto rounded-lg bg-surface p-4 shadow-2xl"
          >
            <MarkdownView {text} class="text-sm text-foreground" />
          </div>
        {:else if kind === 'text' && text !== undefined}
          <pre
            class="min-h-0 w-full flex-1 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-4 font-mono text-xs leading-relaxed text-foreground shadow-2xl break-words">{text}</pre>
        {:else}
          <div
            class="flex h-full w-full flex-col items-center justify-center gap-2 rounded-lg bg-surface text-muted shadow-2xl"
          >
            <FileQuestion size={32} class="text-dimmed" />
            <span class="text-xs">No preview available for this file type</span>
          </div>
        {/if}
        <div class="mt-3 flex items-center gap-3">
          <span class="max-w-full truncate text-xs text-muted">{filename}</span>
        </div>
      </div>
      <button
        type="button"
        class="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full bg-surface text-foreground transition-colors hover:bg-elevated"
        aria-label="Close preview"
        title="Close preview (Esc)"
        onclick={closeFromButton}
      >
        <X size={18} />
      </button>
      <button
        type="button"
        class="absolute right-4 top-16 flex h-8 w-8 items-center justify-center rounded-full bg-surface text-foreground transition-colors hover:bg-elevated"
        aria-label="Download file"
        title="Download file"
        onclick={downloadFromButton}
      >
        <Download size={16} />
      </button>
    </div>
  </Modal>
{/if}

<ConfirmDialog
  open={confirmCloseOpen}
  title="Discard attachment changes?"
  onCancel={() => (confirmCloseOpen = false)}
  onConfirm={() => {
    confirmCloseOpen = false
    onClose()
  }}
  confirmLabel="Discard changes"
  cancelLabel="Keep editing"
>
  <p>
    Your unsaved edits to <span class="font-medium text-foreground">{filename}</span> will be lost.
  </p>
</ConfirmDialog>
