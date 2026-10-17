<script lang="ts">
  import CioClose from '$lib/components/icons/cio/CioClose.svelte'
  import CioDownload from '$lib/components/icons/cio/CioDownload.svelte'
  import CioFileQuestion from '$lib/components/icons/cio/CioFileQuestion.svelte'
  import CioFolderOpen from '$lib/components/icons/cio/CioFolderOpen.svelte'
  import CioSave from '$lib/components/icons/cio/CioSave.svelte'
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  import CioWrapText from '$lib/components/icons/cio/CioWrapText.svelte'
  import Modal from '../ui/Modal.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ProjectTextEditor from '../files/ProjectTextEditor.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import { wrapTextState, wrapToggleLabel } from '$lib/stores/wrap-text.svelte'
  import { PanZoom } from '$lib/pan-zoom.svelte'
  import PanZoomToolbar from '../ui/PanZoomToolbar.svelte'
  import PreviewPager, { type PreviewPagerState } from '../ui/PreviewPager.svelte'
  import type { PromptAttachment } from '$shared/types'
  import { attachmentPreviewKind } from '$lib/mime'
  import { documentPreviewFrame } from '$lib/document-preview-frame'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { revealAttachmentFile } from '$lib/reveal-file'

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
    /** Sibling navigation when the caller opened this preview over more than
     *  one previewable attachment. Absent for a lone file. */
    pager?: PreviewPagerState
    /**
     * Reveal hook for attachments with no `file://` URL of their own, such as
     * an inline thread artifact served over `appfile://`. Mirrors MediaPreview:
     * when present the reveal button shows and runs this instead of the
     * attachment-file reveal.
     */
    onReveal?: () => void
    onClose: () => void
  }

  let {
    attachment,
    src,
    text,
    documentHtml,
    documentLoading = false,
    onSaveText,
    pager,
    onReveal,
    onClose
  }: Props = $props()

  const filename = $derived(attachment.filename ?? 'file')
  const kind = $derived(attachmentPreviewKind(attachment.mime, filename))
  const editableText = $derived(
    (kind === 'markdown' || kind === 'text') && onSaveText !== undefined
  )
  // The editor keeps its own draft rather than mirroring the prop on every
  // keystroke, so typing is not interrupted by a reactive round-trip. The
  // attachment-change effect below resets it when the pager swaps the file.
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

  // The component instance is reused when the pager moves to the next
  // attachment (same mounted block), so both the zoom/pan and the editor draft
  // are reset here: neither may carry over onto another file.
  $effect(() => {
    void attachment.url
    panZoom.zoom = 1
    panZoom.panX = 0
    panZoom.panY = 0
    draft = text ?? ''
  })
  const wrapTitle = $derived(wrapToggleLabel(wrapTextState.wrapped))
  /** Only an attachment that is a real file on disk has a path to reveal,
   *  unless the caller supplied its own reveal mapping (inline artifacts). */
  const revealable = $derived(attachment.url.startsWith('file://') || onReveal !== undefined)

  /** Set while a pager step waits on the unsaved-changes prompt, so confirming
   *  it moves to the sibling attachment instead of closing the preview. */
  let pendingNavigation = $state<(() => void) | null>(null)

  /**
   * Step to a sibling attachment. An editable attachment with unsaved edits
   * routes through the same discard prompt as closing, so navigating away can
   * never throw a draft away silently.
   */
  function navigate(move: () => void): void {
    if (dirty) {
      pendingNavigation = move
      confirmCloseOpen = true
      return
    }
    move()
  }

  /** The pager as rendered: the caller owns the list, this guard owns the
   *  unsaved-edits check that sits between a click and the step. */
  const pagerState = $derived.by<PreviewPagerState | undefined>(() => {
    if (!pager) return undefined
    return {
      index: pager.index,
      count: pager.count,
      onPrevious: () => navigate(pager.onPrevious),
      onNext: () => navigate(pager.onNext)
    }
  })

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

  function revealFromButton(event: MouseEvent): void {
    event.stopPropagation()
    // The reveal lands behind this full screen surface (the file tree, or the
    // OS file manager), so the preview closes itself: staying open hides the
    // result and reads as a button that did nothing. Closing still routes
    // through requestClose, so an editable attachment with a live draft asks
    // before the edits are dropped.
    if (onReveal) onReveal()
    else void revealAttachmentFile(attachment.url)
    requestClose()
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
      {#if pagerState}
        <PreviewPager pager={pagerState} />
      {/if}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 items-center gap-1 bg-primary px-2 text-[0.625rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
        disabled={!dirty || saving}
        title="Save attachment (Cmd/Ctrl+S)"
        onclick={() => void saveText()}
      >
        {#if saving}
          <CioSpinner size={11} class="animate-spin" />
        {:else}
          <CioSave size={11} />
        {/if}
        CioSave
      </button>
      <button
        type="button"
        class={[
          'titlebar-no-drag flex h-7 w-7 items-center justify-center transition-colors hover:bg-elevated hover:text-foreground',
          wrapTextState.wrapped ? 'text-primary' : 'text-dimmed'
        ]}
        aria-label={wrapTitle}
        aria-pressed={wrapTextState.wrapped}
        title={wrapTitle}
        onclick={() => wrapTextState.toggle()}
      >
        <CioWrapText size={14} />
      </button>
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Download attachment"
        title="Download attachment"
        onclick={handleDownload}
      >
        <CioDownload size={14} />
      </button>
      {#if revealable}
        <button
          type="button"
          class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={`Reveal path of ${filename}`}
          title="Reveal path"
          onclick={revealFromButton}
        >
          <CioFolderOpen size={14} />
        </button>
      {/if}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Close attachment editor"
        title="Close attachment editor (Esc)"
        onclick={requestClose}
      >
        <CioClose size={14} />
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
    <!-- A preview is a chrome-less lightbox, so nothing would otherwise keep its
         content out of the window controls drawn over the top-left corner. The
         band doubles as the preview's header: it reserves the same inset the app
         header occupies, stays draggable like every other full screen surface,
         and names the file with its actions here instead of below the content. -->
    <div
      class="titlebar-drag flex h-12 shrink-0 items-center gap-2 border-b border-border pr-3"
      style={trafficLightInsetStyle()}
    >
      <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
        {filename}
      </span>
      {#if revealable}
        <button
          type="button"
          class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={`Reveal path of ${filename}`}
          title="Reveal path"
          onclick={revealFromButton}
        >
          <CioFolderOpen size={14} />
        </button>
      {/if}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Download file"
        title="Download file"
        onclick={downloadFromButton}
      >
        <CioDownload size={14} />
      </button>
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Close preview"
        title="Close preview (Esc)"
        onclick={closeFromButton}
      >
        <CioClose size={14} />
      </button>
    </div>
    <div
      role="presentation"
      class="relative flex min-h-0 flex-1 items-center justify-center"
      onclick={requestClose}
      onkeydown={(e: KeyboardEvent) => {
        if (keymapState.matches('ui-activate', e)) requestClose()
      }}
    >
      <div
        role="presentation"
        class="relative flex h-full min-h-0 w-full flex-col items-center"
        onclick={(e: MouseEvent) => e.stopPropagation()}
      >
        {#if kind === 'image' && src}
          <div
            {@attach imageViewportAttachment}
            role="group"
            class={[
              'flex min-h-0 w-full flex-1 touch-none items-center justify-center overflow-hidden',
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
              class="max-h-full max-w-full object-contain"
              style={panZoom.transform}
            />
          </div>
        {:else if kind === 'video' && src}
          <video {src} controls preload="metadata" class="min-h-0 w-full flex-1 object-contain">
            <track kind="captions" />
          </video>
        {:else if kind === 'audio' && src}
          <audio {src} controls preload="metadata" class="w-full max-w-xl"></audio>
        {:else if kind === 'pdf' && src}
          <iframe {src} class="min-h-0 w-full flex-1 border-0" title={`Preview ${filename}`}
          ></iframe>
        {:else if kind === 'document' && documentSrcdoc}
          <iframe
            srcdoc={documentSrcdoc}
            sandbox=""
            class="min-h-0 w-full flex-1 border-0 bg-surface"
            title={`Preview ${filename}`}
          ></iframe>
        {:else if kind === 'document' && documentLoading}
          <div
            class="flex h-full w-full items-center justify-center bg-surface text-muted shadow-2xl"
            role="status"
          >
            <CioSpinner size={24} class="animate-spin" />
            <span class="sr-only">Loading document preview</span>
          </div>
        {:else if kind === 'markdown' && text !== undefined}
          <div class="flex min-h-0 w-full flex-1 flex-col overflow-auto bg-surface p-4 shadow-2xl">
            <MarkdownView {text} class="text-sm text-foreground" />
          </div>
        {:else if kind === 'text' && text !== undefined}
          <pre
            class="min-h-0 w-full flex-1 overflow-auto whitespace-pre-wrap bg-surface p-4 font-mono text-xs leading-relaxed text-foreground shadow-2xl break-words">{text}</pre>
        {:else}
          <div
            class="flex h-full w-full flex-col items-center justify-center gap-2 bg-surface text-muted shadow-2xl"
          >
            <CioFileQuestion size={32} class="text-dimmed" />
            <span class="text-xs">No preview available for this file type</span>
          </div>
        {/if}
      </div>
      {#if pagerState || (kind === 'image' && src)}
        <!-- The floating controls belong to the content, not to the backdrop
             behind it: the lightbox dismisses on a press of its backdrop, so the
             cluster's own box and the gap between its controls must not read as
             one, and an activation key pressed on a focused control (Enter on
             the zoom toolbar) must not reach the lightbox's activate handler
             either. The controls guard their own buttons; this guards the
             region. -->
        <div
          class="absolute right-3 bottom-3 flex items-center gap-2"
          role="presentation"
          onclick={(event: MouseEvent) => event.stopPropagation()}
          onkeydown={(event: KeyboardEvent) => {
            if (keymapState.matches('ui-activate', event)) event.stopPropagation()
          }}
        >
          {#if pagerState}
            <PreviewPager pager={pagerState} />
          {/if}
          {#if kind === 'image' && src}
            <PanZoomToolbar {panZoom} viewport={imageViewport} />
          {/if}
        </div>
      {/if}
    </div>
  </Modal>
{/if}

<ConfirmDialog
  open={confirmCloseOpen}
  title="Discard attachment changes?"
  onCancel={() => {
    confirmCloseOpen = false
    pendingNavigation = null
  }}
  onConfirm={() => {
    confirmCloseOpen = false
    const move = pendingNavigation
    pendingNavigation = null
    if (move) move()
    else onClose()
  }}
  confirmLabel="Discard changes"
  cancelLabel="Keep editing"
>
  <p>
    Your unsaved edits to <span class="font-medium text-foreground">{filename}</span> will be lost.
  </p>
</ConfirmDialog>
