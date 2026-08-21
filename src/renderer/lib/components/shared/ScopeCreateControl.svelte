<script lang="ts">
  import { Kanban } from '@lucide/svelte'
  import ScopeCreateModal from '../scope/ScopeCreateModal.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'

  interface Props {
    title?: string
  }

  let { title = 'New scope' }: Props = $props()

  let open = $state(false)
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

<ScopeCreateModal
  {open}
  projectId={scopeState.activeProjectId ?? ''}
  onClose={() => (open = false)}
/>
