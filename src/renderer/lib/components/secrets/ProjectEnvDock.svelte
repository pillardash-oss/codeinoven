<script lang="ts">
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioRedo from '@pdslng/cio-icon/CioRedo.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { projectEnvDock } from '$lib/stores/project-env-dock.svelte'
  import { APP_SLUG } from '$shared/brand'
  import {
    DEFAULT_ENV_FILE_NAME,
    validateEnvFileName,
    type ProjectEnvFile
  } from '$shared/project-env'
  import { onMount } from 'svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'

  /**
   * The env file for one path, as a floating editor.
   *
   * A project row's key button and the file explorer's `Secrets` action open this
   * panel for the path they were clicked on. The file itself is named here: any name
   * is allowed, and the panel offers the names that already exist in this directory
   * so the user is never guessing what is hardcoded. The body is the file typed as a
   * `.env`: a line with a value stores it in the vault, a line left empty keeps what
   * is stored, and a deleted line removes the key.
   *
   * Values never travel back from the main process, so a stored key appears as its
   * name with an empty value and an undo/redo history covers the editing session.
   */
  const storageKey = `${APP_SLUG}.projectEnvDock.v1`
  const HISTORY_LIMIT = 200

  let files = $state<ProjectEnvFile[]>([])
  let fileName = $state(DEFAULT_ENV_FILE_NAME)
  let body = $state('')
  /** The body as it was last read or saved, so dirty is the user's own edits. */
  let savedBody = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let error = $state('')
  let outcome = $state('')
  let undoStack = $state<string[]>([])
  let redoStack = $state<string[]>([])

  const group = $derived(projectEnvDock.group)
  const groupLabel = $derived(group || '/')
  const groupFiles = $derived(
    files.filter((file) => file.group === group).map((file) => file.fileName)
  )
  const currentFile = $derived(
    files.find((file) => file.group === group && file.fileName === fileName) ?? null
  )
  const storedCount = $derived(currentFile?.entries.length ?? 0)
  const dirty = $derived(body !== savedBody)
  const canUndo = $derived(undoStack.length > 0)
  const canRedo = $derived(redoStack.length > 0)

  /** The edited file, rendered as a `.env` body: names only, values stay in vault. */
  function bodyFor(file: ProjectEnvFile | null): string {
    if (!file) return ''
    return file.entries.map((entry) => `${entry.name}=`).join('\n')
  }

  function resetHistory(next: string): void {
    body = next
    savedBody = next
    undoStack = []
    redoStack = []
  }

  async function readFiles(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    loading = true
    error = ''
    try {
      files = await invoke('secrets:envList', projectId)
      const available = files.filter((file) => file.group === group)
      const initial =
        available.find((file) => file.fileName === DEFAULT_ENV_FILE_NAME) ?? available[0] ?? null
      fileName = initial?.fileName ?? DEFAULT_ENV_FILE_NAME
      resetHistory(bodyFor(initial))
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not read this path’s env files'
    } finally {
      loading = false
    }
  }

  /** Switch to another file in this directory, reading it first. */
  async function openFile(name: string): Promise<void> {
    let next = ''
    try {
      next = validateEnvFileName(name)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'That file name is not allowed'
      return
    }
    error = ''
    outcome = ''
    fileName = next
    resetHistory(
      bodyFor(files.find((file) => file.group === group && file.fileName === next) ?? null)
    )
  }

  function pushHistory(next: string): void {
    const trimmed = undoStack.slice(-HISTORY_LIMIT)
    trimmed.push(body)
    undoStack = trimmed
    redoStack = []
    body = next
    outcome = ''
  }

  function undo(): void {
    const previous = undoStack.at(-1)
    if (previous === undefined) return
    undoStack = undoStack.slice(0, -1)
    redoStack = [...redoStack, body]
    body = previous
  }

  function redo(): void {
    const next = redoStack.at(-1)
    if (next === undefined) return
    redoStack = redoStack.slice(0, -1)
    undoStack = [...undoStack, body]
    body = next
  }

  async function save(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    saving = true
    error = ''
    outcome = ''
    try {
      const result = await invoke('secrets:envApplyText', {
        projectId,
        group,
        fileName,
        text: body
      })
      files = result.files
      savedBody = body
      undoStack = []
      redoStack = []
      const parts: string[] = []
      if (result.stored.length > 0) {
        parts.push(
          `${result.stored.length} ${result.stored.length === 1 ? 'value' : 'values'} stored`
        )
      }
      if (result.kept.length > 0) parts.push(`${result.kept.length} kept`)
      if (result.removed.length > 0) parts.push(`${result.removed.length} removed`)
      if (result.skipped.length > 0) {
        parts.push(
          `${result.skipped.length} ${result.skipped.length === 1 ? 'line' : 'lines'} ignored`
        )
      }
      outcome = parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing changed.'
      const firstSkip = result.skipped[0]
      if (firstSkip) error = `Line ${firstSkip.line}: ${firstSkip.reason}`
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this env file'
    } finally {
      saving = false
    }
  }

  function handleEditKeydown(event: KeyboardEvent): void {
    if (!(event.metaKey || event.ctrlKey)) return
    const key = event.key.toLowerCase()
    if (key === 'z') {
      event.preventDefault()
      if (event.shiftKey) redo()
      else undo()
      return
    }
    if (key === 'y') {
      event.preventDefault()
      redo()
    }
  }

  onMount(() => {
    void readFiles()
  })
</script>

<DockableModal
  open={true}
  title={fileName}
  minimized={projectEnvDock.minimized}
  closable
  onMinimize={() => projectEnvDock.minimize()}
  onClose={() => projectEnvDock.close()}
  {storageKey}
  dragLabel="Drag to move the env file panel"
  defaultHeight={520}
  flushBody
  onPrimaryAction={() => {
    if (saving || loading || !dirty) return false
    void save()
    return true
  }}
>
  {#snippet headerPrefix()}
    <span class="flex min-w-0 items-center gap-2">
      <span
        class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden border bg-raised text-dimmed"
        style:border-color={projectEnvDock.color ?? undefined}
        aria-hidden="true"
      >
        {#if projectEnvDock.iconUrl}
          <img src={projectEnvDock.iconUrl} alt="" class="h-3.5 w-3.5 object-contain" />
        {:else}
          <CioKey size={12} />
        {/if}
      </span>
      <span
        class="min-w-0 truncate text-xs font-medium text-muted"
        title={projectEnvDock.projectName}
      >
        {projectEnvDock.projectName}
      </span>
      <span class="shrink-0 font-mono text-[0.6875rem] text-dimmed">{groupLabel}</span>
    </span>
  {/snippet}

  {#snippet dock()}
    <DockRow {storageKey} label="Move docked env file">
      <button
        type="button"
        class="flex items-center gap-2 border bg-surface px-2.5 py-1.5 text-left shadow-xl transition-colors hover:bg-elevated"
        title="Show env file for {projectEnvDock.projectName}"
        aria-label="Show env file for {projectEnvDock.projectName}"
        onclick={() => projectEnvDock.expand()}
      >
        <CioKey size={13} class="shrink-0 text-dimmed" />
        <span class="text-[0.625rem] font-medium text-foreground">{fileName}</span>
        <span class="max-w-40 truncate text-[0.5625rem] text-muted"
          >{projectEnvDock.projectName}</span
        >
      </button>
    </DockRow>
  {/snippet}

  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <label class="flex min-w-0 items-center gap-2" for="env-file-name">
        <span class="text-[0.6875rem] font-medium text-muted">File</span>
        <input
          id="env-file-name"
          class="h-7 w-48 border bg-elevated px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
          type="text"
          autocomplete="off"
          spellcheck="false"
          value={fileName}
          oninput={(event) => (fileName = event.currentTarget.value)}
          onblur={() => void openFile(fileName)}
          onkeydown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void openFile(fileName)
            }
          }}
        />
      </label>
      {#if groupFiles.length > 0}
        <div class="flex min-w-0 flex-wrap items-center gap-1" aria-label="Files in this path">
          {#each groupFiles as existing (existing)}
            <button
              type="button"
              class="px-1.5 py-1 font-mono text-[0.6875rem] transition-colors {existing === fileName
                ? 'bg-elevated text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'}"
              aria-pressed={existing === fileName}
              title="Edit {groupLabel}{existing}"
              onclick={() => void openFile(existing)}
            >
              {existing}
            </button>
          {/each}
        </div>
      {/if}
      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
          title="Undo"
          aria-label="Undo the last edit"
          disabled={!canUndo}
          onclick={undo}
        >
          <CioUndo size={13} />
        </button>
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
          title="Redo"
          aria-label="Redo the last undone edit"
          disabled={!canRedo}
          onclick={redo}
        >
          <CioRedo size={13} />
        </button>
        <span class="ml-1 shrink-0 text-[0.6875rem] tabular-nums text-dimmed">
          {storedCount}
          {storedCount === 1 ? 'key' : 'keys'}
        </span>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      {#if loading}
        <div class="flex items-center gap-2 px-3 py-3 text-xs text-muted">
          <CioSpinner size={13} class="animate-spin" /> Reading {groupLabel}{fileName}...
        </div>
      {:else}
        <textarea
          class="h-full w-full resize-none bg-app p-3 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-dimmed"
          spellcheck="false"
          autocomplete="off"
          aria-label="{fileName} for {projectEnvDock.projectName}"
          placeholder="KEY=value"
          value={body}
          oninput={(event) => pushHistory(event.currentTarget.value)}
          onkeydown={handleEditKeydown}></textarea>
      {/if}
    </div>

    {#if error}
      <p
        class="shrink-0 border-t bg-danger/10 px-3 py-1.5 text-[0.6875rem] text-danger"
        role="alert"
      >
        {error}
      </p>
    {:else if outcome}
      <p class="shrink-0 border-t px-3 py-1.5 text-[0.6875rem] text-muted" role="status">
        {outcome}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="border px-3 py-1.5 text-sm"
      data-modal-dismiss
      onclick={() => projectEnvDock.close()}
    >
      Close
    </button>
    <button
      type="button"
      class="bg-primary px-3 py-1.5 text-sm font-medium text-on-primary disabled:opacity-40"
      disabled={saving || loading || !dirty}
      data-modal-primary
      onclick={() => void save()}
    >
      {#if saving}
        <CioSpinner size={13} class="mr-1 inline animate-spin" aria-hidden="true" />
      {/if}
      Save
    </button>
  {/snippet}
</DockableModal>
