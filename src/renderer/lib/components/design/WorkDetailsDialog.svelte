<script lang="ts">
  import { onMount } from 'svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { sanitizeWorkName } from '$shared/design/work-roots'
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
     * a workspace that is its own root, so there is no project-wide move to offer:
     * the dialog moves the one folder and leaves the rest alone.
     */
    projectScope?: boolean
    onClose: () => void
    onUpdated: (directory: string, moved: number) => Promise<void>
  } = $props()
  let rootDraft = $state('')
  let nameDraft = $state('')
  /**
   * Whether the change is about this design or video alone.
   *
   * On is a single move: the folder the dialog is open on goes where the user
   * points it and the project's folder for new work is untouched. Off is the
   * project's own change: every design or video of this project moves, and the
   * folder new ones are written into becomes the one named here.
   */
  let thisOnly = $state(true)
  let busy = $state(false)
  let error = $state('')
  const noun = $derived(kind === 'video' ? 'video' : 'design')
  const renaming = $derived(mode === 'rename')
  const name = $derived(directory.split('/').at(-1) ?? '')
  const nameChanged = $derived(nameDraft !== name)
  const slug = $derived(nameChanged ? sanitizeWorkName(nameDraft) : name)
  /**
   * The scope the request carries, which is what main acts on.
   *
   * A rename changes one folder's name and nothing else, so it is a single-work
   * change however the switch is left.
   */
  const scopeOfChange = $derived<WorkDetailsScope>(
    renaming || thisOnly || !projectScope ? 'work' : 'project'
  )
  const target = $derived(
    renaming
      ? `${directory.split('/').slice(0, -1).join('/')}/${slug}`
      : `${rootDraft.trim()}/${slug}`
  )

  onMount(() => {
    rootDraft = directory.split('/').slice(0, -1).join('/') || root
    nameDraft = name
    thisOnly = mode !== 'all' || !projectScope
  })

  async function save(): Promise<void> {
    if (busy || slug === '' || (!renaming && rootDraft.trim() === '')) return
    busy = true
    error = ''
    try {
      const result = await invoke('design:updateDetails', projectId, threadId, {
        kind,
        directory,
        scope: scopeOfChange,
        ...(!renaming ? { root: rootDraft.trim() } : {}),
        ...(nameChanged ? { name: nameDraft } : {})
      })
      await onUpdated(result.directory, result.moved)
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
  title={renaming ? `Rename ${noun}` : `Change ${noun} save path`}
  onClose={() => {
    if (!busy) onClose()
  }}
>
  <div class="space-y-4 p-4">
    {#if !renaming}
      <label class="block space-y-2 text-sm">
        <span>Save folder relative to {projectScope ? 'this project' : 'this workspace'}</span>
        <input
          class="w-full border border-border bg-elevated px-2 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
          bind:value={rootDraft}
          disabled={busy}
        />
      </label>
    {/if}
    <label class="block space-y-2 text-sm">
      <span>{noun === 'design' ? 'Design name' : 'Video name'}</span>
      <input
        class="w-full border border-border bg-elevated px-2 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
        bind:value={nameDraft}
        disabled={busy}
      />
    </label>
    <p class="text-xs text-muted">The folder name is automatically made URL friendly.</p>
    {#if !renaming && projectScope}
      <Switch
        bind:checked={thisOnly}
        disabled={busy}
        label={`This ${noun} only`}
        aria-label={`Move only this ${noun}`}
      />
      <p class="text-xs text-muted">
        {thisOnly
          ? `Moves only this ${noun}. The project's folder for new ${noun}s is left where it is.`
          : `Sets this project's save folder for new ${noun}s and moves all ${noun}s in it there.`}
      </p>
    {:else if !renaming}
      <p class="text-xs text-muted">
        Moves only this {noun}, inside the workspace it was written in.
      </p>
    {/if}
    <p class="break-all font-mono text-xs text-muted">{target}</p>
    {#if error}<p class="text-xs text-danger" role="alert">{error}</p>{/if}
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="border border-border px-3 py-1.5 text-xs hover:bg-elevated"
      disabled={busy}
      onclick={onClose}>Cancel</button
    >
    <button
      type="button"
      data-modal-primary-action
      class="bg-primary px-3 py-1.5 text-xs text-on-primary disabled:opacity-40"
      disabled={busy || slug === '' || (!renaming && rootDraft.trim() === '')}
      onclick={() => void save()}>{busy ? 'Saving…' : renaming ? 'Rename' : 'Save changes'}</button
    >
  {/snippet}
</Modal>
