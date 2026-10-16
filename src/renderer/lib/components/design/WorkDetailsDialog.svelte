<script lang="ts">
  import { onMount } from 'svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { sanitizeWorkName } from '$shared/design/work-roots'
  import type { AuthoredWorkKind } from '$shared/ipc/design'

  let {
    projectId,
    directory,
    kind,
    root,
    mode,
    onClose,
    onUpdated
  }: {
    projectId: string
    directory: string
    kind: AuthoredWorkKind
    root: string
    mode: 'this' | 'all' | 'rename'
    onClose: () => void
    onUpdated: (directory: string, moved: number) => Promise<void>
  } = $props()
  let draft = $state('')
  let thisOnly = $state(true)
  let busy = $state(false)
  let error = $state('')
  const noun = $derived(kind === 'video' ? 'video' : 'design')
  const renaming = $derived(mode === 'rename')
  const slug = $derived(sanitizeWorkName(draft))
  const name = $derived(directory.split('/').at(-1) ?? '')
  const target = $derived(
    renaming ? `${directory.split('/').slice(0, -1).join('/')}/${slug}` : `${draft.trim()}/${name}`
  )

  onMount(() => {
    draft = mode === 'rename' ? name : directory.split('/').slice(0, -1).join('/') || root
    thisOnly = mode !== 'all'
  })

  async function save(): Promise<void> {
    if (busy || draft.trim() === '' || (renaming && slug === '')) return
    busy = true
    error = ''
    try {
      const result = await invoke('design:updateDetails', projectId, {
        kind,
        directory,
        thisOnly,
        ...(renaming ? { name: draft } : { root: draft.trim() })
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
    <label class="block space-y-2 text-sm">
      <span
        >{renaming
          ? `${noun === 'design' ? 'Design' : 'Video'} name`
          : 'Save folder relative to this project'}</span
      >
      <input
        class="w-full border border-border bg-elevated px-2 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
        bind:value={draft}
        disabled={busy}
      />
    </label>
    {#if !renaming}
      <Switch
        bind:checked={thisOnly}
        disabled={busy}
        label={`This ${noun} only and new ones after`}
        aria-label={`Move only this ${noun} and use this save folder for new ${noun}s`}
      />
      <p class="text-xs text-muted">
        {thisOnly
          ? `Moves this ${noun} and sets the default folder for new ${noun}s in this project.`
          : `Moves all ${noun}s in this project and sets the default folder for new ones.`}
      </p>
    {/if}
    <p class="break-all font-mono text-xs text-muted">{target}</p>
    {#if renaming}<p class="text-xs text-muted">
        The folder name is automatically made URL friendly.
      </p>{/if}
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
      disabled={busy || draft.trim() === '' || (renaming && slug === '')}
      onclick={() => void save()}>{busy ? 'Saving…' : renaming ? 'Rename' : 'Save path'}</button
    >
  {/snippet}
</Modal>
