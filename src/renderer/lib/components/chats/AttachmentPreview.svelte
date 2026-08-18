<script lang="ts">
  import { AlertDialog } from 'bits-ui'
  import { X, Download, FileQuestion, Loader2, Save, WrapText } from '@lucide/svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ProjectTextEditor from '../files/ProjectTextEditor.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import { wrapTextState, wrapToggleLabel } from '$lib/stores/wrap-text.svelte'
  import type { PromptAttachment } from '$shared/types'
  import { attachmentPreviewKind } from '$lib/mime'

  interface Props {
    attachment: PromptAttachment
    /** blob: URL for image/pdf previews, keyed by the attachment url. */
    src?: string
    /** Decoded text content for markdown/plain-text previews. */
    text?: string
    /** Persists edits when this is an app-owned pasted-text attachment. */
    onSaveText?: (text: string) => Promise<void>
    onClose: () => void
  }

  let { attachment, src, text, onSaveText, onClose }: Props = $props()

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
    if (e.key === 'Escape' && !confirmCloseOpen) requestClose()
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && editableText) {
      e.preventDefault()
      void saveText()
    }
  }}
/>

{#if editableText}
  <div class="fixed inset-0 z-50 flex min-h-0 flex-col overflow-hidden bg-app shadow-xl">
    <div
      class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
      style={trafficLightInsetStyle()}
    >
      <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
        {filename}
      </span>
      {#if saveError}
        <span class="max-w-80 truncate text-[10px] text-danger" role="status">{saveError}</span>
      {/if}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 items-center gap-1 rounded bg-primary px-2 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-30"
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
  </div>
{:else}
  <div
    role="presentation"
    class="fixed inset-0 z-50 flex items-center justify-center bg-overlay/80 backdrop-blur-sm"
    onclick={requestClose}
    onkeydown={(e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') requestClose()
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
        <img
          {src}
          alt={filename}
          class="max-h-[80vh] max-w-[85vw] rounded-lg object-contain shadow-2xl"
        />
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
{/if}

<AlertDialog.Root bind:open={confirmCloseOpen}>
  <AlertDialog.Portal>
    <AlertDialog.Overlay class="fixed inset-0 z-50 bg-overlay/70" />
    <AlertDialog.Content
      class="fixed left-1/2 top-1/2 z-50 w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-xl"
    >
      <AlertDialog.Title class="text-sm font-semibold text-foreground">
        Discard attachment changes?
      </AlertDialog.Title>
      <AlertDialog.Description class="mt-2 text-xs leading-5 text-muted">
        Your unsaved edits to {filename} will be lost.
      </AlertDialog.Description>
      <div class="mt-5 flex justify-end gap-2">
        <AlertDialog.Cancel
          class="h-8 rounded-lg border border-border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay"
        >
          Keep editing
        </AlertDialog.Cancel>
        <AlertDialog.Action
          class="h-8 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90"
          onclick={onClose}
        >
          Discard changes
        </AlertDialog.Action>
      </div>
    </AlertDialog.Content>
  </AlertDialog.Portal>
</AlertDialog.Root>
