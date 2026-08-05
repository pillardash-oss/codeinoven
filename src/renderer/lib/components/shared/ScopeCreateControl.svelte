<script lang="ts">
  import { Kanban } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'

  interface Props {
    title?: string
  }

  let { title = 'New scope' }: Props = $props()

  const componentId = $props.id()
  const createScopeFormId = `${componentId}-create-scope-form`

  let open = $state(false)
  let name = $state('')
  let error = $state<string | null>(null)

  function close(): void {
    open = false
    name = ''
    error = null
  }

  async function createScope(): Promise<void> {
    if (!name.trim()) return
    try {
      await scopeState.createBucket(name)
      close()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The scope could not be created.'
    }
  }
</script>

<button
  class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
  aria-label={title}
  {title}
  disabled={!scopeState.activeProjectId}
  onclick={() => (open = true)}
>
  <Kanban size={15} strokeWidth={1.8} />
</button>

<Modal {open} title="New Scope" onClose={close}>
  <form
    id={createScopeFormId}
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void createScope()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="header-new-scope-name">
        Name
      </label>
      <input
        id="header-new-scope-name"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
        placeholder="Authentication"
        bind:value={name}
      />
      {#if error}
        <p class="mt-1.5 text-xs text-danger">{error}</p>
      {/if}
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={close}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={createScopeFormId}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={!name.trim() || scopeState.saving}
    >
      Create
    </button>
  {/snippet}
</Modal>
