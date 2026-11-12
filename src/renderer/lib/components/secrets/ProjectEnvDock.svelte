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
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { noticeDismissals } from '$lib/stores/notice-dismissals.svelte'
  import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
  import { projectEnvDock } from '$lib/stores/project-env-dock.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { APP_SLUG } from '$shared/brand'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'
  import {
    DEFAULT_ENV_FILE_NAME,
    formatEnvValue,
    parseProjectEnvFile,
    validateEnvFileName,
    type ProjectEnvFile
  } from '$shared/project-env'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import { onMount, tick } from 'svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import FindInBar from '../files/FindInBar.svelte'
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

  /** A document parked while the panel shows another target. */
  interface DockDraft {
    body: string
    rows: KeyRow[]
    savedBody: string
    undoStack: Snapshot[]
    redoStack: Snapshot[]
    surface: Surface
    skipped: { line: number; reason: string }[]
  }

  let files = $state<ProjectEnvFile[]>([])
  let fileName = $state(DEFAULT_ENV_FILE_NAME)
  /** The directory the rows and editor currently hold, so a switch can park it. */
  let loadedGroup = $state('')
  /** The file the rows and editor currently hold, so a stray blur cannot reload. */
  let loadedFileName = $state('')
  /** The project the loaded document belongs to, so a new one starts clean. */
  let loadedProjectId = $state('')
  /** Everything opened here, so the picker still offers a file with no keys yet. */
  let visited = $state<{ group: string; fileName: string }[]>([])
  /**
   * Documents with unsaved edits, one per target.
   *
   * Switching the picker used to reload the target and throw the draft away. A
   * document being edited is parked here instead and restored when its target is
   * opened again, so a key typed in one file survives a look at another.
   */
  const drafts = new SvelteMap<string, DockDraft>()
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
   * Every file the picker offers.
   *
   * A project keeps its secrets per directory, and remembering which directory
   * holds the key you want means walking the file tree first. The picker names the
   * location instead, so any file is one click away. It lists every stored file of
   * the project plus every target opened here, because a draft the user opened in
   * a directory that holds no stored keys yet must stay reachable.
   */
  const pickerTargets = $derived.by(() => {
    const targets: { value: string; label: string; group: string; fileName: string }[] = []
    const add = (targetGroup: string, name: string): void => {
      const value = `${targetGroup}/${name}`
      if (targets.some((target) => target.value === value)) return
      targets.push({
        value,
        group: targetGroup,
        fileName: name,
        label: targetGroup ? `${targetGroup}/${name}` : name
      })
    }
    for (const file of files) add(file.group, file.fileName)
    for (const entry of visited) add(entry.group, entry.fileName)
    add(group, fileName)
    return targets.sort((left, right) =>
      left.group === right.group
        ? left.label.localeCompare(right.label)
        : left.group.localeCompare(right.group)
    )
  })
  const selectedTarget = $derived(`${group}/${fileName}`)

  /** Jump the panel to another target, keeping every target's own draft. */
  function selectStoredTarget(value: string): void {
    // The location is `group/fileName` and a group holds slashes, so the file name
    // is what follows the last one.
    const split = value.lastIndexOf('/')
    const targetFileName = split < 0 ? value : value.slice(split + 1)
    if (!targetFileName) return
    const targetGroup = split < 0 ? '' : value.slice(0, split)
    // The name is updated here as well, so the picker shows the chosen location
    // right away instead of waiting for the file's values to load.
    fileName = targetFileName
    projectEnvDock.select({ group: targetGroup, fileName: targetFileName })
  }

  /** Whether a target holds edits that were never saved. */
  function isTargetDirty(targetGroup: string, targetFileName: string): boolean {
    if (targetGroup === loadedGroup && targetFileName === loadedFileName) {
      return dirty || hasUnnamedRow
    }
    return drafts.has(targetKey(targetGroup, targetFileName))
  }

  /** A draft is keyed by the project and the location it belongs to. */
  function targetKey(targetGroup: string, targetFileName: string): string {
    return `${projectEnvDock.projectId ?? ''}\u0000${targetGroup}\u0000${targetFileName}`
  }

  /** Remember a target for as long as this dock is open. */
  function markVisited(targetGroup: string, targetFileName: string): void {
    if (visited.some((entry) => entry.group === targetGroup && entry.fileName === targetFileName)) {
      return
    }
    visited = [...visited, { group: targetGroup, fileName: targetFileName }]
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
  /** A key whose name is still being typed: not in the file, but not disposable. */
  const hasUnnamedRow = $derived(
    surface === 'keys' && rows.some((row) => row.name.trim().length === 0)
  )

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
    if (projectId !== loadedProjectId) {
      loadedProjectId = projectId
      visited = []
      drafts.clear()
    } else {
      // The store's target already moved, so the document being left is parked
      // first; otherwise its unsaved edits are gone.
      stashDraft()
    }
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
      await loadDocument(group, fileName, initial)
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
    // A minimized dock has no rows in the document, so it has to come back before
    // there is anything to reveal; and a filtered list may hide the row the link
    // names, so the bar steps out of the way.
    if (projectEnvDock.minimized) projectEnvDock.expand()
    if (findOpen) closeFind()
    if (surface !== 'keys') switchSurface('keys')
    await tick()
    const row = rows.find((candidate) => candidate.name === name)
    if (!row) return
    const field = document.getElementById(`env-key-value-${row.id}`)
    if (field instanceof HTMLInputElement) {
      // Focusing first would let the browser pick the scroll offset itself, so the
      // caret lands in the field and the row is then centred in its scroller.
      field.focus({ preventScroll: true })
      field.select()
    }
    highlightRowId = row.id
    // The panel is still laying itself out after the surface and content swap, so
    // the row is measured on the next frame instead of scrolling to a stale offset.
    requestAnimationFrame(() => {
      document
        .getElementById(`env-key-row-${row.id}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
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

  /** Read a target into both surfaces, preferring the draft parked there. */
  async function loadDocument(
    targetGroup: string,
    targetFileName: string,
    file: ProjectEnvFile | null
  ): Promise<void> {
    const key = targetKey(targetGroup, targetFileName)
    const draft = drafts.get(key)
    if (draft) {
      // The restored document is the live one now, so the parked copy is done; a
      // later switch parks it again from what the user has by then.
      drafts.delete(key)
      restoreDraft(draft)
    } else {
      await resetDocument(file)
    }
    loadedGroup = targetGroup
    loadedFileName = targetFileName
    markVisited(targetGroup, targetFileName)
  }

  /** Park the loaded document when it holds edits, drop it when it does not. */
  function stashDraft(): void {
    if (!loadedFileName) return
    const key = targetKey(loadedGroup, loadedFileName)
    if (dirty || hasUnnamedRow) drafts.set(key, captureDraft())
    else drafts.delete(key)
  }

  function captureDraft(): DockDraft {
    return {
      body,
      rows: rows.map((row) => ({ ...row })),
      savedBody,
      undoStack: [...undoStack],
      redoStack: [...redoStack],
      surface,
      skipped: [...skipped]
    }
  }

  function restoreDraft(draft: DockDraft): void {
    body = draft.body
    rows = draft.rows.map((row) => ({ ...row }))
    savedBody = draft.savedBody
    undoStack = [...draft.undoStack]
    redoStack = [...draft.redoStack]
    surface = draft.surface
    skipped = [...draft.skipped]
    revealed.clear()
  }

  /** Validate a name a header field or a sibling button submitted. */
  function validateName(name: string): string | null {
    try {
      return validateEnvFileName(name)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'That file name is not allowed'
      return null
    }
  }

  /** Open another file of the same directory, parking the current draft first. */
  async function openSibling(name: string): Promise<void> {
    const next = validateName(name)
    if (next === null) return
    if (next === loadedFileName && group === loadedGroup) {
      fileName = next
      return
    }
    error = ''
    outcome = ''
    skipped = []
    stashDraft()
    fileName = next
    const file =
      files.find((candidate) => candidate.group === group && candidate.fileName === next) ?? null
    await loadDocument(group, next, file)
  }

  /**
   * Rename the open file in place.
   *
   * A rename is not a move to another document, so a draft being edited travels
   * with the name instead of being thrown away and reloaded from its stored keys.
   */
  async function renameFile(name: string): Promise<void> {
    const next = validateName(name)
    if (next === null) return
    // The header field doubles as the file's name, so a blur that changed nothing
    // must not reopen the file and throw away its undo history.
    if (next === loadedFileName) {
      fileName = next
      return
    }
    error = ''
    outcome = ''
    skipped = []
    const carried = dirty ? captureDraft() : null
    drafts.delete(targetKey(loadedGroup, loadedFileName))
    if (carried) {
      drafts.set(targetKey(loadedGroup, next), carried)
      fileName = next
      loadedFileName = next
      markVisited(loadedGroup, next)
      return
    }
    const sequence = projectEnvDock.sequence
    const file =
      files.find((candidate) => candidate.group === loadedGroup && candidate.fileName === next) ??
      null
    const key = targetKey(loadedGroup, next)
    const draft = drafts.get(key)
    if (draft) {
      drafts.delete(key)
      restoreDraft(draft)
    } else {
      await resetDocument(file)
    }
    // The picker moved on while this read ran, so its target owns the panel now.
    if (projectEnvDock.sequence !== sequence) return
    fileName = next
    loadedFileName = next
    markVisited(loadedGroup, next)
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

  // ─── Find ─────────────────────────────────────────────────────────────────

  let findOpen = $state(false)
  let findQuery = $state('')
  let findIndex = $state(0)
  let findFocusTrigger = $state(0)

  /** Key rows whose name or value holds the query. */
  const findRows = $derived.by(() => {
    const query = findQuery.trim().toLowerCase()
    if (!query) return rows
    return rows.filter(
      (row) => row.name.toLowerCase().includes(query) || row.value.toLowerCase().includes(query)
    )
  })
  /** Matches in the plain editor, so the same chord finds text there too. */
  const findTextRanges = $derived.by(() => {
    const query = findQuery.trim().toLowerCase()
    if (surface !== 'editor' || !query) return [] as { start: number; end: number }[]
    const haystack = body.toLowerCase()
    const ranges: { start: number; end: number }[] = []
    let from = 0
    while (ranges.length < 500) {
      const at = haystack.indexOf(query, from)
      if (at < 0) break
      ranges.push({ start: at, end: at + query.length })
      from = at + Math.max(query.length, 1)
    }
    return ranges
  })
  const findMatchCount = $derived(surface === 'keys' ? findRows.length : findTextRanges.length)
  const findActiveIndex = $derived(
    findMatchCount === 0 ? 0 : Math.min(findIndex, findMatchCount - 1)
  )
  /** While the bar holds a query, the key list shows only what it found. */
  const findFiltersRows = $derived(findOpen && surface === 'keys' && findQuery.trim().length > 0)
  const visibleRows = $derived(findFiltersRows ? findRows : rows)

  function openFind(): void {
    findOpen = true
    findFocusTrigger += 1
  }

  function closeFind(): void {
    findOpen = false
    findQuery = ''
    findIndex = 0
  }

  function updateFind(query: string): void {
    findQuery = query
    findIndex = 0
    void revealFindMatch()
  }

  /** Move to the next or previous match, wrapping at either end. */
  function moveFind(step: number): void {
    if (findMatchCount === 0) return
    findIndex = (findActiveIndex + step + findMatchCount) % findMatchCount
    void revealFindMatch()
  }

  /** Put the active match where the reader can see it, on either surface. */
  async function revealFindMatch(): Promise<void> {
    await tick()
    if (findMatchCount === 0) return
    if (surface === 'keys') {
      const row = findRows[findActiveIndex]
      if (!row) return
      document.getElementById(`env-key-row-${row.id}`)?.scrollIntoView({ block: 'nearest' })
      return
    }
    const range = findTextRanges[findActiveIndex]
    const editor = document.getElementById('env-editor')
    if (!range || !(editor instanceof HTMLTextAreaElement)) return
    editor.focus({ preventScroll: true })
    editor.setSelectionRange(range.start, range.end)
    // A textarea does not scroll itself to a selection the way a document does.
    const line = editor.value.slice(0, range.start).split('\n').length
    const inlineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 16
    editor.scrollTop = Math.max(0, (line - 3) * inlineHeight)
  }

  /** The dock is the focused surface, so its save and find chords win over the
   *  file panel it floats above instead of editing whatever sits behind it. */
  function handleDockKeydown(event: KeyboardEvent): void {
    if (confirmWrite || confirmDiscard) return
    if (keymapState.matches('files-save', event)) {
      event.preventDefault()
      event.stopPropagation()
      if (saving || loading || !dirty) return
      void save()
      return
    }
    if (keymapState.matches('nav-find', event)) {
      event.preventDefault()
      event.stopPropagation()
      openFind()
    }
  }

  /** Take the reader to the project's latest thread, picked the way creating a
   *  pull request picks it: newest activity first, archived rows out. */
  async function openLatestProjectThread(): Promise<void> {
    const projectId = projectEnvDock.projectId
    if (!projectId) return
    try {
      const threads: Thread[] = await invoke('thread:listAll')
      const latest = threads
        .filter((thread) => thread.projectId === projectId && !thread.archived)
        .filter((thread) => !isOrchestrationChildThread(thread))
        .sort((left, right) => right.lastActivity - left.lastActivity)[0]
      if (!latest) return
      const project =
        scopeState.projectRecords.find((candidate) => candidate.id === projectId) ??
        (await invoke('project:get', projectId))
      if (!project) return
      workspaceState.openThreadInOwningView(latest, project)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not open the latest thread'
    }
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
      // The stored file is what the panel now holds, so its parked draft is done.
      drafts.delete(targetKey(group, fileName))
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

  let confirmDiscard = $state(false)
  /** Unsaved work anywhere in this panel, the open target or a parked draft. */
  const hasUnsaved = $derived(dirty || hasUnnamedRow || drafts.size > 0)
  /** Every target that still holds edits, named the way the picker names it. */
  const unsavedLabels = $derived(
    visited
      .filter((entry) => isTargetDirty(entry.group, entry.fileName))
      .map((entry) => (entry.group ? `${entry.group}/${entry.fileName}` : entry.fileName))
  )

  /** Closing is the only thing that discards a draft, so it asks first. */
  function requestClose(): void {
    if (hasUnsaved) {
      confirmDiscard = true
      return
    }
    loseAndClose()
  }

  function loseAndClose(): void {
    drafts.clear()
    confirmDiscard = false
    projectEnvDock.close()
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
  onClose={requestClose}
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
  {#snippet headerTitle()}
    <input
      id="env-file-name"
      class="h-6 w-40 min-w-0 truncate border border-transparent bg-transparent px-1 font-mono text-xs font-semibold text-foreground outline-none transition-colors hover:border-border focus:border-primary"
      type="text"
      autocomplete="off"
      spellcheck="false"
      aria-label="Env file name"
      title="Rename this env file"
      value={fileName}
      oninput={(event) => (fileName = event.currentTarget.value)}
      onblur={() => void renameFile(fileName)}
      onkeydown={(event) => {
        handleDockKeydown(event)
        if (event.defaultPrevented) return
        if (event.key === 'Enter') {
          event.preventDefault()
          void renameFile(fileName)
        }
      }}
    />
  {/snippet}

  {#snippet headerPrefix()}
    <span class="flex min-w-0 items-center gap-2">
      <button
        type="button"
        class="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden border bg-raised text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        style:border-color={projectEnvDock.color ?? undefined}
        title="Open {projectEnvDock.projectName}'s latest thread"
        aria-label="Open {projectEnvDock.projectName}'s latest thread"
        onclick={() => void openLatestProjectThread()}
      >
        {#if projectEnvDock.iconUrl}
          <img src={projectEnvDock.iconUrl} alt="" class="h-3.5 w-3.5 object-contain" />
        {:else}
          <CioKey size={12} />
        {/if}
      </button>
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

  <!-- The panel is a group around its own focused controls, and the handler is
       only here to keep the app-level save chord from editing the surface behind
       the dock. It has no interaction of its own to describe. -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="flex h-full min-h-0 flex-col"
    role="group"
    aria-label="Env file editor"
    onkeydown={handleDockKeydown}
  >
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
      <label class="flex min-w-0 items-center gap-2" for="env-file-picker">
        <span class="text-[0.6875rem] font-medium text-muted">Stored</span>
        <select
          id="env-file-picker"
          class="h-7 max-w-64 min-w-0 border bg-elevated px-2 font-mono text-xs text-foreground outline-none transition-colors hover:bg-overlay focus:border-primary disabled:opacity-50"
          value={selectedTarget}
          disabled={loading || pickerTargets.length === 0}
          title="Show the secrets stored for another file in this project"
          aria-label="Secrets stored for this project"
          onchange={(event) => selectStoredTarget(event.currentTarget.value)}
        >
          {#each pickerTargets as target (target.value)}
            <option value={target.value}
              >{target.label}{isTargetDirty(target.group, target.fileName)
                ? ' (unsaved)'
                : ''}</option
            >
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
            onclick={() => void openSibling(existing)}
          >
            {existing}
          </button>
        {/each}
      </div>
    {/if}

    {#if findOpen}
      <div class="shrink-0 border-b p-1.5">
        <FindInBar
          query={findQuery}
          matches={findMatchCount}
          activeIndex={findActiveIndex}
          placeholder={surface === 'keys' ? 'Find a key or value' : 'Find in this file'}
          label="Find in this env file"
          focusTrigger={findFocusTrigger}
          onQueryChange={updateFind}
          onNext={() => moveFind(1)}
          onPrev={() => moveFind(-1)}
          onClose={closeFind}
        />
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if loading}
        <div class="flex items-center gap-2 px-3 py-3 text-xs text-muted">
          <CioSpinner size={13} class="animate-spin" /> Reading {groupPrefix}{fileName}...
        </div>
      {:else if surface === 'editor'}
        <textarea
          id="env-editor"
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
          {#each visibleRows as row (row.id)}
            {@const stored =
              currentFile?.entries.some((entry) => entry.name === row.name.trim()) ?? false}
            <div
              id="env-key-row-{row.id}"
              class="flex items-center gap-2 px-3 py-1.5 {highlightRowId === row.id ||
              (findFiltersRows && findRows[findActiveIndex]?.id === row.id)
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
          {:else if findFiltersRows && findRows.length === 0}
            <p class="px-3 py-3 text-xs text-muted">No keys match this search.</p>
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
      onclick={requestClose}
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

<ConfirmDialog
  open={confirmDiscard}
  title="Discard unsaved changes?"
  confirmLabel="Discard and close"
  onCancel={() => (confirmDiscard = false)}
  onConfirm={loseAndClose}
>
  <p>
    {#if unsavedLabels.length > 1}
      These files hold edits that were never saved:
      {#each unsavedLabels as label (label)}
        <span class="block font-mono text-foreground">{label}</span>
      {/each}
    {:else}
      <span class="font-mono text-foreground"
        >{unsavedLabels[0] ?? `${groupPrefix}${fileName}`}</span
      > has edits that were never saved.
    {/if}
    Closing now discards {unsavedLabels.length > 1 ? 'them' : 'it'}.
  </p>
</ConfirmDialog>
