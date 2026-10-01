<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    Braces,
    Eye,
    FileCode2,
    FolderOpen,
    Loader2,
    RotateCw,
    Save
  } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  import { beautifyFileContent, fileBeautifyLabel } from '$lib/file-beautify'
  import { documentPreviewFrame, htmlPreviewFrame } from '$lib/document-preview-frame'
  import { standaloneFilePreviewUrl } from '$lib/file-preview'
  import { invoke } from '$lib/ipc.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { ipcErrorMessage } from '$lib/ipc-errors'
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
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import FileImagePreview from './FileImagePreview.svelte'
  import FileMediaPreview from './FileMediaPreview.svelte'
  import ProjectTextEditor from './ProjectTextEditor.svelte'

  interface Props {
    /** Absolute path of the file the operating system handed over. */
    path: string
    /** Display name (the basename main resolved). */
    name: string
    /**
     * Whether this pane owns the Cmd/Ctrl+S save chord. The docked panel turns it
     * off while collapsed into its dock chip, so a minimized file does not keep
     * the chord from the surface the user is actually looking at.
     */
    saveShortcutEnabled?: boolean
  }

  let { path, name, saveShortcutEnabled = true }: Props = $props()

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
  /** Kinds whose content can never be read as text and whose preview streams
   *  bytes to the element instead of crossing IPC. SVG is deliberately excluded:
   *  it is XML, so its source stays editable while its preview renders from a blob. */
  const binaryPreview = $derived(pdf || video || audio || documentPreview || (image && !svg))
  /** Format this file can be beautified as ("JSON"), or null when the editor
   *  has no beautifier for it. The label doubles as the flag, so the action is
   *  never offered when it could not run, exactly like the project editor. */
  const beautifyLabel = $derived(fileBeautifyLabel(path))

  /** The file's editable text state. Null until it is read, and null forever for
   *  kinds that have no text form. */
  const session = $derived(standaloneFiles.session(path))
  const dirty = $derived(session ? session.draft !== session.source.content : false)

  /** Rendered kinds default to preview (like the project editor does); text and
   *  code default to the source view. `view` stays null until the user picks
   *  explicitly, so the default keeps following the file (the pane is re-created
   *  per file) without an effect resetting it. */
  let view = $state<View | null>(null)
  const defaultView = $derived<View>(binaryPreview ? 'preview' : 'source')
  const activeView = $derived<View>(view ?? defaultView)
  let reloadToken = $state(0)
  let loading = $state(false)
  let loadError = $state<string | null>(null)
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
  // Previews follow the draft, so an unsaved edit is visible immediately (the
  // project editor behaves the same way).
  const htmlSrcdoc = $derived(htmlPreview && session ? htmlPreviewFrame(session.draft) : null)

  /**
   * SVG is previewed from a data URL built from the draft. The privileged
   * `appfile://` scheme refuses to serve SVG, and an `<img>` rendering a data URL
   * cannot run the document's scripts, so the same active-XML protection holds.
   * Building it from the draft rather than from the last read means an unsaved SVG
   * edit shows in the preview immediately, with no object-URL lifecycle to manage.
   */
  const svgPreviewSrc = $derived(
    svg && session ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(session.draft)}` : null
  )

  async function loadSource(): Promise<void> {
    if (binaryPreview) {
      loadError = null
      loading = false
      return
    }
    const sequence = ++requestSequence
    loading = true
    loadError = null
    try {
      const file = await standaloneFiles.loadText(path)
      if (sequence !== requestSequence) return
      loadError = file === null ? 'This file cannot be displayed as text' : null
    } catch (error) {
      if (sequence !== requestSequence) return
      loadError = ipcErrorMessage(error, 'This file could not be read')
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
      documentError = ipcErrorMessage(error, 'The document could not be previewed')
    } finally {
      if (sequence === requestSequence) documentLoading = false
    }
  }

  /** Cmd/Ctrl+S saves the file the user is looking at. App.svelte owns the same
   *  chord for folding the sidebar, and defers to this handler whenever a
   *  standalone file has unsaved edits. Shift is excluded, Cmd/Ctrl+Shift+S
   *  belongs to the right-sidebar toggle alone. */
  function handleSaveShortcut(event: KeyboardEvent): void {
    if (!saveShortcutEnabled) return
    if (!keymapState.matches('files-save', event)) return
    if (!standaloneFiles.isDirty(path)) return
    event.preventDefault()
    void standaloneFiles.save(path)
  }

  onMount(() => {
    // A session already in the store means this file was read before (the user
    // switched tabs): re-reading would throw the draft away.
    if (!standaloneFiles.session(path)) void loadSource()
    void loadDocument()
    window.addEventListener('keydown', handleSaveShortcut)
    return () => {
      requestSequence += 1
      window.removeEventListener('keydown', handleSaveShortcut)
    }
  })

  /** True while the confirmation for reloading a dirty buffer is open. */
  let reloadConfirmOpen = $state(false)

  function reload(): void {
    if (dirty) {
      reloadConfirmOpen = true
      return
    }
    applyReload()
  }

  function applyReload(): void {
    reloadToken += 1
    void reloadFromDisk()
    void loadDocument()
  }

  async function reloadFromDisk(): Promise<void> {
    if (binaryPreview) {
      loadError = null
      return
    }
    const sequence = ++requestSequence
    loading = true
    loadError = null
    await standaloneFiles.reload(path)
    if (sequence !== requestSequence) return
    loading = false
  }

  /** Reformat this file's draft in place. The result is left unsaved on purpose:
   *  the pane goes dirty, the Save button lights up, and the editor's own
   *  history keeps the previous layout one undo away. */
  function beautifySource(): void {
    const label = beautifyLabel
    if (!session || label === null) return
    const outcome = beautifyFileContent(path, session.draft)
    if (outcome.status === 'invalid') {
      toast.error(`${label} could not be beautified`, { description: outcome.message })
      return
    }
    if (outcome.status === 'unchanged') {
      toast.info(`${label} is already beautified`)
      return
    }
    if (outcome.status !== 'formatted') return
    standaloneFiles.updateDraft(path, outcome.text)
    toast.success(`${label} beautified`, { description: 'Save the file to keep the change.' })
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
  {#if dirty}
    <span
      class="ml-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
      role="status"
      title="Unsaved changes"
      aria-label="Unsaved changes"
    ></span>
  {/if}
  {#if session && beautifyLabel && activeView === 'source'}
    <button
      type="button"
      class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={`Beautify ${beautifyLabel}`}
      title={`Beautify ${beautifyLabel}`}
      onclick={beautifySource}
    >
      <Braces size={12} />
    </button>
  {/if}
  {#if session}
    <button
      type="button"
      class="ml-1 flex h-6 items-center gap-1 rounded px-1.5 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-dimmed"
      aria-label={`Save ${name}`}
      title={session.error ? `Save ${name} (last attempt failed)` : `Save ${name}`}
      disabled={!dirty || session.saving}
      onclick={() => void standaloneFiles.save(path)}
    >
      {#if session.saving}
        <Loader2 size={12} class="animate-spin" />
      {:else}
        <Save size={12} />
      {/if}
      <span class="text-[0.625rem]">Save</span>
    </button>
  {/if}
  <button
    type="button"
    class="flex h-6 w-6 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
    aria-label="Reload the file from disk"
    title="Reload from disk"
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

{#if session?.error}
  <div class="flex shrink-0 items-start gap-2 border-b border-border bg-danger/10 px-2 py-1.5">
    <AlertTriangle size={12} class="mt-0.5 shrink-0 text-danger" />
    <p class="min-w-0 flex-1 text-[0.625rem] break-words text-danger">{session.error}</p>
    {#if !binaryPreview}
      <button
        type="button"
        class="shrink-0 rounded border border-border px-1.5 py-0.5 text-[0.625rem] font-medium text-foreground hover:bg-elevated"
        title="Reload the disk version, discarding this draft"
        onclick={reload}
      >
        Reload from disk
      </button>
    {/if}
  </div>
{/if}

{#if loading}
  <div
    class="flex flex-1 items-center justify-center gap-2 text-[0.6875rem] text-dimmed"
    role="status"
  >
    <Loader2 size={13} class="animate-spin" />
    Loading file
  </div>
{:else if activeView === 'preview' && markdown && session}
  <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
    <MarkdownView text={session.draft} class="text-sm text-foreground" />
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
  <FileImagePreview src={svg ? svgPreviewSrc : previewUrl} alt={name} />
{:else if activeView === 'preview' && (video || audio)}
  <FileMediaPreview src={previewUrl} alt={name} kind={video ? 'video' : 'audio'} />
{:else if session}
  <ProjectTextEditor
    value={session.draft}
    {path}
    ariaLabel={`Edit ${name}`}
    onInput={(input) => standaloneFiles.updateDraft(path, input.currentTarget.value)}
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

<ConfirmDialog
  open={reloadConfirmOpen}
  title={`Discard unsaved changes to ${name} and reload it from disk?`}
  onCancel={() => (reloadConfirmOpen = false)}
  onConfirm={applyReload}
  confirmLabel="Discard and reload"
>
  <p>The version on disk replaces your unsaved edits.</p>
</ConfirmDialog>
