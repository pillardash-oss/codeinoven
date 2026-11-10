<script lang="ts">
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioEye from '@pdslng/cio-icon/CioEye.svelte'
  import CioEyeOff from '@pdslng/cio-icon/CioEyeOff.svelte'
  import CioKey from '@pdslng/cio-icon/CioKey.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioRedo from '@pdslng/cio-icon/CioRedo.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'
  import { projectEnvDock } from '$lib/stores/project-env-dock.svelte'
  import { APP_SLUG } from '$shared/brand'
  import {
    DEFAULT_ENV_FILE_NAME,
    parseProjectEnvFile,
    validateEnvFileName,
    type ProjectEnvFile
  } from '$shared/project-env'
  import { SvelteSet } from 'svelte/reactivity'
  import { onMount } from 'svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import NoticeDismissButton from '../ui/NoticeDismissButton.svelte'

  /**
   * The env file for one path, as a floating editor.
   *
   * A project row's key button and the file explorer's `Secrets` action open this
   * panel for the path they were clicked on. The file is named here: any name is
   * allowed, and the panel offers the names that already exist in this directory.
   *
   * Two ways to edit the same body. `Editor` is the plain file. `Keys` is the same
   * file as rows, each value a password field with its own reveal control, because a
   * stored value is never read back: typing a new one replaces it, leaving it blank
   * keeps what the vault holds.
   */
  const storageKey = `${APP_SLUG}.projectEnvDock.v1`
  const HISTORY_LIMIT = 200

  type Surface = 'editor' | 'keys'

  let files = $state<ProjectEnvFile[]>([])
  let fileName = $state(DEFAULT_ENV_FILE_NAME)
  let body = $state('')
  let savedBody = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let writing = $state(false)
  let error = $state('')
  let outcome = $state('')
  let skipped = $state<{ line: number; reason: string }[]>([])
  let surface = $state<Surface>('editor')
  let undoStack = $state<string[]>([])
  let redoStack = $state<string[]>([])
  const revealed = new SvelteSet<number>()
  let confirmWrite = $state(false)

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

  /**
   * The body's key lines, so the row surface edits the very same text the editor
   * shows: comments and blank lines are preserved, and both surfaces stay one
   * undoable document.
   */
  const rows = $derived(
    parseProjectEnvFile(body).flatMap((line, index) =>
      line.kind === 'assignment'
        ? [
            {
              index,
              name: line.name,
              value: line.value,
              stored: currentFile?.entries.some((key) => key.name === line.name) ?? false
            }
          ]
        : []
    )
  )

  const skipNoticeId = $derived(`secrets.envSkip.${projectEnvDock.projectId}.${group}.${fileName}`)
  const skipCondition = $derived(skipped.map((entry) => `${entry.line}:${entry.reason}`).join('|'))
  const skipDismissed = $derived(
    skipCondition.length > 0 && noticeDismissals.isDismissed(skipNoticeId, skipCondition)
  )

  function bodyFor(file: ProjectEnvFile | null): string {
    if (!file) return ''
    return file.entries.map((entry) => `${entry.name}=`).join('\n')
  }

  function resetHistory(next: string): void {
    body = next
    savedBody = next
    undoStack = []
    redoStack = []
    revealed.clear()
  }

  function record(next: string): void {
    if (next === body) return
    undoStack = [...undoStack.slice(-HISTORY_LIMIT), body]
    redoStack = []
    body = next
    outcome = ''
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
    skipped = []
    fileName = next
    const file = files.find((candidate) => candidate.group === group && candidate.fileName === next)
    resetHistory(bodyFor(file ?? null))
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

  /** Rewrite one key line, keeping every other line where the user left it. */
  function setRow(
    index: number,
    change: { name?: string; value?: string } | 'remove' | 'add'
  ): void {
    const lines = body.split('\n')
    if (change === 'add') {
      record([...lines, ''].join('\n'))
      return
    }
    const current = parseProjectEnvFile(body)
    const line = current[index]
    if (!line || line.kind !== 'assignment') return
    if (change === 'remove') {
      record(lines.filter((_, position) => position !== index).join('\n'))
      return
    }
    // A key name only ever holds identifier characters, so an accidental space or
    // "=" cannot make the line disappear under the caret.
    const name = change.name === undefined ? line.name : change.name.replace(/[^A-Za-z0-9_]/gu, '')
    const value = change.value ?? line.value
    const next = [...lines]
    next[index] = `${name}=${value}`
    record(next.join('\n'))
  }

  function addRow(): void {
    const lines = body.length > 0 ? body.split('\n') : []
    record([...lines, 'NEW_KEY='].join('\n'))
  }

  function toggleReveal(index: number): void {
    if (revealed.has(index)) revealed.delete(index)
    else revealed.add(index)
  }

  async function save(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    saving = true
    error = ''
    outcome = ''
    skipped = []
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
      skipped = result.skipped
      const parts: string[] = []
      if (result.stored.length > 0) {
        parts.push(
          `${result.stored.length} ${result.stored.length === 1 ? 'value' : 'values'} stored`
        )
      }
      if (result.kept.length > 0) parts.push(`${result.kept.length} kept`)
      if (result.removed.length > 0) parts.push(`${result.removed.length} removed`)
      outcome = parts.length > 0 ? `${parts.join(', ')}.` : 'Nothing changed.'
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save this env file'
    } finally {
      saving = false
    }
  }

  async function writeToProject(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    writing = true
    error = ''
    outcome = ''
    try {
      const result = await invoke('secrets:envWriteToProject', {
        projectId,
        group,
        fileName
      })
      confirmWrite = false
      outcome = result.changed
        ? `Wrote ${result.path}${result.backupPath ? `, previous content kept as ${result.backupPath}` : ''}.`
        : `${result.path} already holds these references.`
      files = await invoke('secrets:envList', projectId)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not write this file into the project'
    } finally {
      writing = false
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
          class="h-7 w-44 border bg-elevated px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
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

      <div
        class="flex items-center gap-0.5 border bg-elevated p-0.5"
        role="tablist"
        aria-label="Editor mode"
      >
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'editor'}
          class="px-2 py-1 text-[0.6875rem] font-medium transition-colors {surface === 'editor'
            ? 'bg-surface text-foreground'
            : 'text-muted hover:text-foreground'}"
          title="Edit the file as plain text"
          onclick={() => (surface = 'editor')}
        >
          Editor
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={surface === 'keys'}
          class="px-2 py-1 text-[0.6875rem] font-medium transition-colors {surface === 'keys'
            ? 'bg-surface text-foreground'
            : 'text-muted hover:text-foreground'}"
          title="Edit the file key by key, with values hidden"
          onclick={() => (surface = 'keys')}
        >
          Keys
        </button>
      </div>

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

    {#if groupFiles.length > 1}
      <div class="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-1.5">
        <span class="text-[0.625rem] font-semibold tracking-wide text-dimmed uppercase"
          >In this path</span
        >
        {#each groupFiles as existing (existing)}
          <button
            type="button"
            class="px-1.5 py-0.5 font-mono text-[0.6875rem] transition-colors {existing === fileName
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

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if loading}
        <div class="flex items-center gap-2 px-3 py-3 text-xs text-muted">
          <CioSpinner size={13} class="animate-spin" /> Reading {groupLabel}{fileName}...
        </div>
      {:else if surface === 'editor'}
        <textarea
          class="h-full min-h-64 w-full resize-none bg-app p-3 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-dimmed"
          spellcheck="false"
          autocomplete="off"
          aria-label="{fileName} for {projectEnvDock.projectName}"
          placeholder="KEY=value"
          value={body}
          oninput={(event) => record(event.currentTarget.value)}
          onkeydown={handleEditKeydown}></textarea>
      {:else}
        <div class="divide-y">
          {#each rows as row (row.index)}
            <div class="flex items-center gap-2 px-3 py-1.5">
              <input
                class="h-7 w-52 shrink-0 border bg-elevated px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                type="text"
                autocomplete="off"
                spellcheck="false"
                aria-label="Key name"
                value={row.name}
                oninput={(event) => setRow(row.index, { name: event.currentTarget.value })}
              />
              <div class="flex min-w-0 flex-1 items-center gap-1">
                <input
                  class="h-7 min-w-0 flex-1 border bg-elevated px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                  type={revealed.has(row.index) ? 'text' : 'password'}
                  autocomplete="off"
                  spellcheck="false"
                  aria-label="Value for {row.name || 'this key'}"
                  placeholder={row.stored ? 'Stored. Type to replace.' : 'Value'}
                  value={row.value}
                  oninput={(event) => setRow(row.index, { value: event.currentTarget.value })}
                />
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  aria-pressed={revealed.has(row.index)}
                  title={revealed.has(row.index) ? 'Hide this value' : 'Show this value'}
                  aria-label={revealed.has(row.index) ? 'Hide this value' : 'Show this value'}
                  onclick={() => toggleReveal(row.index)}
                >
                  {#if revealed.has(row.index)}
                    <CioEyeOff size={13} />
                  {:else}
                    <CioEye size={13} />
                  {/if}
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                  title="Remove {row.name || 'this key'} from the file"
                  aria-label="Remove {row.name || 'this key'} from the file"
                  onclick={() => setRow(row.index, 'remove')}
                >
                  <CioClose size={13} />
                </button>
              </div>
            </div>
          {/each}
          <div class="flex items-center px-3 py-2">
            <button
              type="button"
              class="flex h-7 items-center gap-1.5 border px-2 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Add a key to this file"
              onclick={addRow}
            >
              <CioPlus size={12} /> Add key
            </button>
          </div>
        </div>
      {/if}
    </div>

    {#if skipped.length > 0 && !skipDismissed}
      <div
        class="flex shrink-0 items-start gap-2 border-t bg-raised px-3 py-2 text-[0.6875rem] text-muted"
        role="status"
      >
        <span class="min-w-0 flex-1">
          {#each skipped as notice (notice.line)}
            <span class="block">Line {notice.line}: {notice.reason}</span>
          {/each}
        </span>
        <NoticeDismissButton
          id={skipNoticeId}
          condition={skipCondition}
          title="Dismiss these notices"
          size="sm"
        />
      </div>
    {/if}

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
      class="border px-3 py-1.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-40"
      disabled={saving || writing || storedCount === 0}
      title="Write NAME=cio://<ref> lines into the project so the file names the values it uses"
      onclick={() => (confirmWrite = true)}
    >
      Write to project
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

<ConfirmDialog
  open={confirmWrite}
  title="Write this file into the project?"
  confirmLabel="Write file"
  busy={writing}
  onCancel={() => (confirmWrite = false)}
  onConfirm={writeToProject}
>
  <p>
    <span class="font-mono text-foreground">{groupLabel}{fileName}</span>
    is rewritten to hold one <span class="font-mono">NAME=cio://&lt;ref&gt;</span> line per key. Any
    content already there is kept beside it as
    <span class="font-mono">{fileName}.cio-backup</span>.
  </p>
</ConfirmDialog>
