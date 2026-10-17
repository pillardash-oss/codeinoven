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
  let rootDraft = $state('')
  let nameDraft = $state('')
  let thisOnly = $state(true)
  let busy = $state(false)
  let error = $state('')
  const noun = $derived(kind === 'video' ? 'video' : 'design')
  const renaming = $derived(mode === 'rename')
  const name = $derived(directory.split('/').at(-1) ?? '')
  const nameChanged = $derived(nameDraft !== name)
  const slug = $derived(nameChanged ? sanitizeWorkName(nameDraft) : name)
  const target = $derived(
    renaming
      ? `${directory.split('/').slice(0, -1).join('/')}/${slug}`
      : `${rootDraft.trim()}/${slug}`
  )

  onMount(() => {
    rootDraft = directory.split('/').slice(0, -1).join('/') || root
    nameDraft = name
    thisOnly = mode !== 'all'
  })

  async function save(): Promise<void> {
    if (busy || slug === '' || (!renaming && rootDraft.trim() === '')) return
    busy = true
    error = ''
    try {
      const result = await invoke('design:updateDetails', projectId, {
        kind,
        directory,
        thisOnly,
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
        <span>Save folder relative to this project</span>
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
    {#if !renaming}
      <Switch
        bind:checked={thisOnly}
        disabled={busy}
        label={`This ${noun} only`}
        aria-label={`Move only this ${noun}`}
      />
      <p class="text-xs text-muted">
        {thisOnly
          ? `Moves only this ${noun}. The default folder for new ${noun}s stays unchanged.`
          : `Moves all ${noun}s in this project and sets the default folder for new ones.`}
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
