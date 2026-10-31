<script lang="ts">
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import { onMount } from 'svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { DEFAULT_WORK_ROOTS, sanitizeWorkName } from '$shared/design/work-roots'
  import type { AuthoredWorkKind, WorkDetailsScope } from '$shared/ipc/design'

  let {
    projectId,
    threadId,
    directory,
    kind,
    root,
    mode,
    projectScope = true,
    onClose,
    onUpdated
  }: {
    projectId: string
    /** The thread whose scope holds this folder; its workspace is the root. */
    threadId: string
    directory: string
    kind: AuthoredWorkKind
    root: string
    mode: 'this' | 'all' | 'rename'
    /**
     * Whether this scope stores one save folder for all of its work.
     *
     * A project does. An assistant's, a chat's and a browser tab's work lives in
     * a workspace that is its own root, so there is no project-wide setting to
     * offer: the dialog moves the one folder and leaves the rest alone.
     */
    projectScope?: boolean
    onClose: () => void
    /**
     * The folder the board should show, how many folders moved, and the save
     * folder when the change was that setting: a saved folder moves nothing, so
     * the count alone cannot say what happened.
     */
    onUpdated: (directory: string, moved: number, savedRoot?: string) => Promise<void>
  } = $props()
  let rootDraft = $state('')
  let nameDraft = $state('')
  /** The folder the dialog opened on, so the save action knows nothing changed. */
  let initialRoot = $state('')
  let busy = $state(false)
  let error = $state('')
  const noun = $derived(kind === 'video' ? 'video' : 'design')
  const renaming = $derived(mode === 'rename')
  /**
   * Whether this dialog edits the save folder rather than one folder's own place.
   *
   * A save folder is where NEW work is written. It is a setting, so changing it
   * moves nothing: every design or composition already written stays exactly where
   * it is. Moving one folder is the other dialog, which touches that one folder
   * only. A conversation workspace has no save-folder setting, so it never takes
   * this shape.
   */
  const settingsOnly = $derived(mode === 'all' && projectScope)
  const defaultRoot = $derived(DEFAULT_WORK_ROOTS[kind])
  const atDefault = $derived(rootDraft.trim() === defaultRoot)
  const name = $derived(directory.split('/').at(-1) ?? '')
  const nameChanged = $derived(nameDraft !== name)
  const slug = $derived(nameChanged ? sanitizeWorkName(nameDraft) : name)
  const scopeOfChange = $derived<WorkDetailsScope>(settingsOnly ? 'project' : 'work')
  const target = $derived(
    settingsOnly
      ? rootDraft.trim()
      : `${renaming ? directory.split('/').slice(0, -1).join('/') : rootDraft.trim()}/${slug}`
  )
  const valid = $derived(
    settingsOnly
      ? rootDraft.trim() !== ''
      : renaming
        ? slug !== ''
        : slug !== '' && rootDraft.trim() !== ''
  )
  const dirty = $derived(
    settingsOnly
      ? rootDraft.trim() !== initialRoot
      : nameChanged || (!renaming && rootDraft.trim() !== initialRoot)
  )
  const label = $derived(renaming ? 'Rename' : settingsOnly ? 'Save' : 'Move')

  function folderOf(path: string): string {
    return path.split('/').slice(0, -1).join('/')
  }

  onMount(() => {
    // The save-folder dialog opens on the folder new work is written into; a move
    // opens on the folder this design or composition already sits in.
    rootDraft = settingsOnly ? root : folderOf(directory) || root
    initialRoot = rootDraft
    nameDraft = name
  })

  /** Put the path field back to the app's own folder for this kind of work. */
  function resetPath(): void {
    rootDraft = defaultRoot
  }

  async function save(): Promise<void> {
    if (busy || !valid || !dirty) return
    busy = true
    error = ''
    try {
      const result = await invoke('design:updateDetails', projectId, threadId, {
        kind,
        directory,
        scope: scopeOfChange,
        ...(!renaming ? { root: rootDraft.trim() } : {}),
        ...(!settingsOnly && nameChanged ? { name: nameDraft } : {})
      })
      await onUpdated(result.directory, result.moved, settingsOnly ? rootDraft.trim() : undefined)
      onClose()
    } catch (failure) {
      error = failure instanceof Error ? failure.message : 'The details could not be updated.'
    } finally {
      busy = false
    }
  }
</script>

<Modal
  open
  title={renaming
    ? `Rename ${noun}`
    : settingsOnly
      ? `Save folder for new ${noun}s`
      : `Move ${noun}`}
  onClose={() => {
    if (!busy) onClose()
  }}
>
  <div class="space-y-4">
    {#if !renaming}
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="work-folder-path">
          {settingsOnly ? `Folder for new ${noun}s` : `Folder this ${noun} moves to`}
        </label>
        <div class="flex gap-2">
          <input
            id="work-folder-path"
            type="text"
            class="min-w-0 flex-1 border bg-elevated px-3 py-2 font-mono text-sm text-foreground placeholder:text-dimmed disabled:opacity-50"
            placeholder={defaultRoot}
            bind:value={rootDraft}
            autocomplete="off"
            spellcheck={false}
            disabled={busy}
          />
          <button
            type="button"
            class="flex shrink-0 items-center gap-1.5 border bg-surface px-3 py-2 text-sm text-foreground transition-colors hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-50"
            title={`Reset to the default folder, ${defaultRoot}`}
            aria-label={`Reset to the default folder, ${defaultRoot}`}
            disabled={busy || atDefault}
            onclick={resetPath}
          >
            <CioRefresh size={14} />
            Default
          </button>
        </div>
        <p class="mt-1 text-xs text-dimmed">
          {settingsOnly
            ? `Relative to ${projectScope ? 'this project' : 'this workspace'}. New ${noun}s are written here, and the ${noun}s already saved stay where they are.`
            : `Relative to ${projectScope ? 'this project' : 'this workspace'}. Only this ${noun} moves, and the folder for new ${noun}s is left as it is.`}
        </p>
      </div>
    {/if}
    {#if !settingsOnly}
      <div>
        <label class="mb-1 block text-xs font-medium text-muted" for="work-folder-name">
          {noun === 'design' ? 'Design name' : 'Video name'}
        </label>
        <input
          id="work-folder-name"
          type="text"
          class="w-full border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed disabled:opacity-50"
          bind:value={nameDraft}
          autocomplete="off"
          spellcheck={false}
          disabled={busy}
        />
        <p class="mt-1 text-xs text-dimmed">The folder name is made URL friendly automatically.</p>
      </div>
    {/if}
    {#if target !== ''}
      <p class="border bg-surface px-3 py-2">
        <span class="block text-xs font-medium text-muted">
          {settingsOnly ? 'New work lands in' : 'Goes to'}
        </span>
        <span class="mt-0.5 block break-all font-mono text-xs text-foreground">{target}</span>
      </p>
    {/if}
    {#if error}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}
  </div>

  {#snippet footer()}
    <button
      type="button"
      data-modal-dismiss
      class="border bg-elevated px-3 py-2 text-sm font-medium hover:bg-overlay disabled:cursor-not-allowed disabled:opacity-50"
      disabled={busy}
      onclick={onClose}>Cancel</button
    >
    <button
      type="button"
      data-modal-primary
      class="bg-primary px-3 py-2 text-sm font-semibold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      disabled={busy || !valid || !dirty}
      onclick={() => void save()}>{busy ? 'Saving…' : label}</button
    >
  {/snippet}
</Modal>
