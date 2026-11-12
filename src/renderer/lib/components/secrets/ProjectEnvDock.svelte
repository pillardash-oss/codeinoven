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
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { projectEnvDock } from '$lib/stores/project-env-dock.svelte'
  import { APP_SLUG } from '$shared/brand'
  import {
    DEFAULT_ENV_FILE_NAME,
    formatEnvValue,
    parseProjectEnvFile,
    validateEnvFileName,
    type ProjectEnvFile
  } from '$shared/project-env'
  import { SvelteSet } from 'svelte/reactivity'
  import { onMount, tick } from 'svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import NoticeDismissButton from '../ui/NoticeDismissButton.svelte'

  /**
   * The env file for one path, as a floating editor.
   *
   * Two ways to edit one document. `Editor` is the plain file, comments and all.
   * `Keys` is the same file as rows: a key field, a value field hidden behind its own
   * reveal toggle, and per-row removal. A row being typed is never thrown away for
   * having no name yet, because a name is what the user is in the middle of writing;
   * an unnamed row simply does not reach the file.
   *
   * The values are read from the vault when the file opens, because an environment
   * variable is something its owner looks at and edits whenever they want. That read
   * is the one channel excluded from everything an agent can call or list.
   */
  const storageKey = `${APP_SLUG}.projectEnvDock.v1`
  const HISTORY_LIMIT = 200

  type Surface = 'editor' | 'keys'

  interface KeyRow {
    id: number
    name: string
    value: string
  }

  /** One undoable state of the document, carrying both surfaces together. */
  interface Snapshot {
    body: string
    rows: KeyRow[]
  }

  let files = $state<ProjectEnvFile[]>([])
  let fileName = $state(DEFAULT_ENV_FILE_NAME)
  let body = $state('')
  let rows = $state<KeyRow[]>([])
  let savedBody = $state('')
  let loading = $state(true)
  let saving = $state(false)
  let writing = $state(false)
  let error = $state('')
  let outcome = $state('')
  let skipped = $state<{ line: number; reason: string }[]>([])
  let surface = $state<Surface>('editor')
  let undoStack = $state<Snapshot[]>([])
  let redoStack = $state<Snapshot[]>([])
  const revealed = new SvelteSet<string>()
  let confirmWrite = $state(false)
  /** The row a `cio://` link pointed at, outlined until the reader moves on. */
  let highlightRowId = $state<number | null>(null)

  const group = $derived(projectEnvDock.group)
  const groupLabel = $derived(group || '/')
  /** The directory as a prefix, so a label built from it reads as one path. */
  const groupPrefix = $derived(group ? `${group}/` : '')
  const groupFiles = $derived(
    files.filter((file) => file.group === group).map((file) => file.fileName)
  )
  /**
   * Every stored file of the project as one picker.
   *
   * A project keeps its secrets per directory, and remembering which directory
   * holds the key you want means walking the file tree first. The picker names the
   * location instead, so any file is one click away.
   */
  const storedTargets = $derived(
    [...files]
      .sort((left, right) =>
        left.group === right.group
          ? left.fileName.localeCompare(right.fileName)
          : left.group.localeCompare(right.group)
      )
      .map((file) => ({
        value: `${file.group}/${file.fileName}`,
        label: file.group ? `${file.group}/${file.fileName}` : file.fileName
      }))
  )
  const selectedTarget = $derived(`${group}/${fileName}`)
  const selectedTargetListed = $derived(
    storedTargets.some((target) => target.value === selectedTarget)
  )

  /** Jump the panel to another stored file, keeping its editor surface. */
  function selectStoredTarget(value: string): void {
    const target = files.find((file) => `${file.group}/${file.fileName}` === value)
    if (!target) return
    // The name is updated here as well, so the picker shows the chosen location
    // right away instead of waiting for the file's values to load.
    fileName = target.fileName
    projectEnvDock.select({ group: target.group, fileName: target.fileName })
  }
  const currentFile = $derived(
    files.find((file) => file.group === group && file.fileName === fileName) ?? null
  )
  const storedCount = $derived(currentFile?.entries.length ?? 0)
  const canUndo = $derived(undoStack.length > 0)
  const canRedo = $derived(redoStack.length > 0)

  /** A row id is stable while rows are added and removed, so focus and reveal track. */
  let nextRowId = 1

  /**
   * The document as the current surface holds it.
   *
   * In `Keys` the rows are authoritative, so an unnamed row survives until the user
   * saves; serializing simply leaves it out of the file.
   */
  const draft = $derived(surface === 'keys' ? serializeRows(rows) : body)
  const dirty = $derived(draft !== savedBody)

  const skipNoticeId = $derived(`secrets.envSkip.${projectEnvDock.projectId}.${group}.${fileName}`)
  const skipCondition = $derived(skipped.map((entry) => `${entry.line}:${entry.reason}`).join('|'))
  const skipDismissed = $derived(
    skipCondition.length > 0 && noticeDismissals.isDismissed(skipNoticeId, skipCondition)
  )

  function parseRows(text: string): KeyRow[] {
    return parseProjectEnvFile(text).flatMap((line) =>
      line.kind === 'assignment' ? [{ id: nextRowId++, name: line.name, value: line.value }] : []
    )
  }

  /** Comment and blank lines belong to the file, so the key rows never rewrite them. */
  function serializeRows(list: readonly KeyRow[]): string {
    return list
      .filter((row) => row.name.trim().length > 0)
      .map((row) => `${row.name.trim()}=${formatEnvValue(row.value)}`)
      .join('\n')
  }

  function currentSnapshot(): Snapshot {
    return { body, rows: rows.map((row) => ({ ...row })) }
  }

  function stateFor(next: { body?: string; rows?: KeyRow[] }): Snapshot {
    if (next.rows) return { body: serializeRows(next.rows), rows: next.rows }
    const text = next.body ?? body
    return { body: text, rows: parseRows(text) }
  }

  /** Apply one edit and make it undoable. */
  function commit(next: { body?: string; rows?: KeyRow[] }): void {
    undoStack = [...undoStack.slice(-HISTORY_LIMIT), currentSnapshot()]
    redoStack = []
    const applied = stateFor(next)
    body = applied.body
    rows = applied.rows
    outcome = ''
  }

  function restore(snapshot: Snapshot): void {
    body = snapshot.body
    rows = snapshot.rows.map((row) => ({ ...row }))
  }

  async function readFiles(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    loading = true
    error = ''
    try {
      files = await invoke('secrets:envList', projectId)
      const available = files.filter((file) => file.group === group)
      // A link named the file it came from, so open exactly that one even when it
      // does not exist yet; anything else falls back to the usual default.
      const preferred = projectEnvDock.fileName
      const matched = preferred
        ? (available.find((file) => file.fileName === preferred) ?? null)
        : null
      const initial =
        matched ??
        (preferred
          ? null
          : (available.find((file) => file.fileName === DEFAULT_ENV_FILE_NAME) ??
            available[0] ??
            null))
      fileName = initial?.fileName ?? preferred ?? DEFAULT_ENV_FILE_NAME
      await resetDocument(initial)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not read this path’s env files'
    } finally {
      loading = false
    }
    // Until this flag clears the panel still renders its reading state, so the rows
    // a link points at do not exist yet; the key is brought into view only now.
    if (!error) await focusPendingKey()
  }

  /**
   * Bring the key a `cio://` link named into view.
   *
   * The link opened the panel to reveal one value, so the panel switches to rows,
   * puts the caret in that key's value and outlines the row for a moment instead of
   * leaving the reader to find it in a long file.
   */
  async function focusPendingKey(): Promise<void> {
    const name = projectEnvDock.takeFocusName()
    if (!name) return
    if (surface !== 'keys') switchSurface('keys')
    await tick()
    const row = rows.find((candidate) => candidate.name === name)
    if (!row) return
    const field = document.getElementById(`env-key-value-${row.id}`)
    if (field instanceof HTMLInputElement) {
      // Focusing first would let the browser pick the scroll offset itself, so the
      // caret lands in the field and the field is then centred in its scroller.
      field.focus({ preventScroll: true })
      field.select()
    }
    field?.scrollIntoView({ block: 'center' })
    highlightRowId = row.id
    window.setTimeout(() => {
      if (highlightRowId === row.id) highlightRowId = null
    }, 2_400)
  }

  /** Read a file's values into both surfaces and start a clean history. */
  async function resetDocument(file: ProjectEnvFile | null): Promise<void> {
    const text = await readBody(file)
    body = text
    rows = parseRows(text)
    savedBody = text
    undoStack = []
    redoStack = []
    revealed.clear()
  }

  async function readBody(file: ProjectEnvFile | null): Promise<string> {
    const projectId = projectEnvDock.projectId
    if (!projectId || !file) return ''
    const values = await invoke('secrets:envValues', {
      projectId,
      group: file.group,
      fileName: file.fileName
    })
    const byName = new Map(values.entries.map((entry) => [entry.name, entry.value ?? '']))
    return file.entries
      .map((entry) => `${entry.name}=${formatEnvValue(byName.get(entry.name) ?? '')}`)
      .join('\n')
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
    await resetDocument(
      files.find((candidate) => candidate.group === group && candidate.fileName === next) ?? null
    )
  }

  function undo(): void {
    const previous = undoStack.at(-1)
    if (!previous) return
    undoStack = undoStack.slice(0, -1)
    redoStack = [...redoStack, currentSnapshot()]
    restore(previous)
  }

  function redo(): void {
    const next = redoStack.at(-1)
    if (!next) return
    redoStack = redoStack.slice(0, -1)
    undoStack = [...undoStack, currentSnapshot()]
    restore(next)
  }

  function switchSurface(next: Surface): void {
    if (next === surface) return
    if (next === 'keys') {
      rows = parseRows(body)
      revealed.clear()
      surface = 'keys'
      return
    }
    body = serializeRows(rows)
    surface = 'editor'
  }

  /** Add a blank key, then put the caret in it and bring it on screen. */
  async function addRow(): Promise<void> {
    const row: KeyRow = { id: nextRowId++, name: '', value: '' }
    commit({ rows: [...rows, row] })
    await tick()
    const field = document.getElementById(`env-key-name-${row.id}`)
    field?.scrollIntoView({ block: 'nearest' })
    if (field instanceof HTMLInputElement) field.focus()
  }

  function updateRow(id: number, change: Partial<Pick<KeyRow, 'name' | 'value'>>): void {
    commit({
      rows: rows.map((row) => (row.id === id ? { ...row, ...change } : row))
    })
  }

  function removeRow(id: number): void {
    commit({ rows: rows.filter((row) => row.id !== id) })
  }

  function toggleReveal(id: number): void {
    const key = String(id)
    if (revealed.has(key)) revealed.delete(key)
    else revealed.add(key)
  }

  function untouchedNames(text: string): string[] {
    const before = new Map(
      parseProjectEnvFile(savedBody).flatMap((line) =>
        line.kind === 'assignment' ? [[line.name, `${line.name}=${line.value}`] as const] : []
      )
    )
    return parseProjectEnvFile(text).flatMap((line) => {
      if (line.kind !== 'assignment') return []
      return before.get(line.name) === `${line.name}=${line.value}` ? [line.name] : []
    })
  }

  async function save(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    // In the editor the body is the file, comments included; in Keys the rows are.
    const text = surface === 'keys' ? serializeRows(rows) : body
    // An unnamed row is a key still being typed; it stays in the panel and is
    // reported rather than silently discarded.
    const unnamed = rows.filter((row) => row.name.trim().length === 0).length
    saving = true
    error = ''
    outcome = ''
    skipped = []
    try {
      const result = await invoke('secrets:envApplyText', {
        projectId,
        group,
        fileName,
        text,
        keep: untouchedNames(text)
      })
      files = result.files
      savedBody = text
      if (surface === 'keys') {
        rows = parseRows(text)
        revealed.clear()
      }
      undoStack = []
      redoStack = []
      skipped = [
        ...result.skipped,
        ...(unnamed > 0
          ? [
              {
                line: 0,
                reason: `${unnamed} ${unnamed === 1 ? 'key has' : 'keys have'} no name yet and ${
                  unnamed === 1 ? 'was' : 'were'
                } not saved`
              }
            ]
          : [])
      ]
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
      await save()
      const result = await invoke('secrets:envWriteToProject', { projectId, group, fileName })
      confirmWrite = false
      outcome = result.changed
        ? `Wrote ${result.path}${result.backupPath ? `, previous content kept as ${result.backupPath}` : ''}.`
        : `${result.path} already holds these references.`
      files = await invoke('secrets:envList', projectId)
      // The project tree has to show the file and its backup now, not after a
      // manual refresh: the write happened off the tree's own action.
      await projectFilesWorkspace.refresh(projectId, result.path)
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

  // The dock stays mounted while the same project is open, so a second reference
  // link re-targets the file and key here instead of remounting the panel.
  let appliedSequence = projectEnvDock.sequence
  $effect(() => {
    const sequence = projectEnvDock.sequence
    if (sequence === appliedSequence) return
    appliedSequence = sequence
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
  defaultHeight={640}
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

      <label class="flex min-w-0 items-center gap-2" for="env-file-picker">
        <span class="text-[0.6875rem] font-medium text-muted">Stored</span>
        <select
          id="env-file-picker"
          class="h-7 max-w-64 min-w-0 border bg-elevated px-2 font-mono text-xs text-foreground outline-none transition-colors hover:bg-overlay focus:border-primary disabled:opacity-50"
          value={selectedTarget}
          disabled={loading || storedTargets.length === 0}
          title="Show the secrets stored for another file in this project"
          aria-label="Secrets stored for this project"
          onchange={(event) => selectStoredTarget(event.currentTarget.value)}
        >
          {#if !selectedTargetListed}
            <option value={selectedTarget}>{groupPrefix}{fileName}</option>
          {/if}
          {#each storedTargets as target (target.value)}
            <option value={target.value}>{target.label}</option>
          {/each}
        </select>
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
          onclick={() => switchSurface('editor')}
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
          onclick={() => switchSurface('keys')}
        >
          Keys
        </button>
      </div>

      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        {#if surface === 'keys'}
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center border text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Add a key"
            aria-label="Add a key to this env file"
            onclick={() => void addRow()}
          >
            <CioPlus size={13} />
          </button>
          <span class="mx-0.5 h-4 w-px bg-border" aria-hidden="true"></span>
        {/if}
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
            title="Edit {groupPrefix}{existing}"
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
          <CioSpinner size={13} class="animate-spin" /> Reading {groupPrefix}{fileName}...
        </div>
      {:else if surface === 'editor'}
        <textarea
          class="h-full min-h-64 w-full resize-none bg-app p-3 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-dimmed"
          spellcheck="false"
          autocomplete="off"
          aria-label="{fileName} for {projectEnvDock.projectName}"
          placeholder="KEY=value"
          value={body}
          oninput={(event) => commit({ body: event.currentTarget.value })}
          onkeydown={handleEditKeydown}></textarea>
      {:else}
        <div class="divide-y">
          {#each rows as row (row.id)}
            {@const stored =
              currentFile?.entries.some((entry) => entry.name === row.name.trim()) ?? false}
            <div
              id="env-key-row-{row.id}"
              class="flex items-center gap-2 px-3 py-1.5 {highlightRowId === row.id
                ? 'bg-primary/10'
                : ''}"
            >
              <input
                id="env-key-name-{row.id}"
                class="h-7 w-52 shrink-0 border bg-elevated px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                type="text"
                autocomplete="off"
                spellcheck="false"
                placeholder="New key"
                aria-label="Key name"
                value={row.name}
                oninput={(event) => updateRow(row.id, { name: event.currentTarget.value })}
              />
              <div class="flex min-w-0 flex-1 items-center gap-1">
                <input
                  id="env-key-value-{row.id}"
                  class="h-7 min-w-0 flex-1 border bg-elevated px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                  type={revealed.has(String(row.id)) ? 'text' : 'password'}
                  autocomplete="off"
                  spellcheck="false"
                  aria-label="Value for {row.name.trim() || 'this key'}"
                  placeholder={stored ? 'Stored. Type to replace.' : 'Value'}
                  value={row.value}
                  oninput={(event) => updateRow(row.id, { value: event.currentTarget.value })}
                />
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  aria-pressed={revealed.has(String(row.id))}
                  title={revealed.has(String(row.id)) ? 'Hide this value' : 'Show this value'}
                  aria-label={revealed.has(String(row.id)) ? 'Hide this value' : 'Show this value'}
                  onclick={() => toggleReveal(row.id)}
                >
                  {#if revealed.has(String(row.id))}
                    <CioEyeOff size={13} />
                  {:else}
                    <CioEye size={13} />
                  {/if}
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                  title="Remove {row.name.trim() || 'this key'} from the file"
                  aria-label="Remove {row.name.trim() || 'this key'} from the file"
                  onclick={() => removeRow(row.id)}
                >
                  <CioClose size={13} />
                </button>
              </div>
            </div>
          {/each}
          {#if rows.length === 0}
            <p class="px-3 py-3 text-xs text-muted">No keys yet. Use the plus button to add one.</p>
          {/if}
        </div>
      {/if}
    </div>

    {#if skipped.length > 0 && !skipDismissed}
      <div
        class="flex shrink-0 items-start gap-2 border-t bg-raised px-3 py-2 text-[0.6875rem] text-muted"
        role="status"
      >
        <span class="min-w-0 flex-1">
          {#each skipped as notice (notice.line + notice.reason)}
            <span class="block">
              {#if notice.line > 0}Line {notice.line}:{/if}
              {notice.reason}
            </span>
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
    <span class="font-mono text-foreground">{groupPrefix}{fileName}</span>
    is rewritten to hold one <span class="font-mono">NAME=cio://&lt;ref&gt;</span> line per key. Any
    content already there is kept at
    <span class="font-mono">.cio/secrets/{groupPrefix}{fileName}</span>, inside the ignored
    <span class="font-mono">.cio</span> folder.
  </p>
</ConfirmDialog>
