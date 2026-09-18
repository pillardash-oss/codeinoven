<script lang="ts">
  /**
   * Assignment review: the trigger and bubble a worker task uses to choose the
   * Git scope it will run in, mirroring the model picker's popover mechanism so
   * it escapes the review card's scroll container.
   */
  import { onMount } from 'svelte'
  import { Popover } from 'bits-ui'
  import { Folder, FolderTree } from '@lucide/svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import ScopePickerMenu from './ScopePickerMenu.svelte'
  import ScopeCreateModal from '$lib/components/scope/ScopeCreateModal.svelte'
  import type { ScopeChoice } from '$shared/types'

  interface Props {
    projectId: string
    /** The Assignment's own scope, i.e. what `inherit` resolves to. */
    inheritBucketId?: string
    value: ScopeChoice
    disabled?: boolean
    onSelect: (choice: ScopeChoice) => void
  }

  let { projectId, inheritBucketId, value, disabled = false, onSelect }: Props = $props()

  let open = $state(false)
  let createModalOpen = $state(false)

  let inheritBucket = $derived(
    inheritBucketId
      ? scopeState.boards.get(projectId)?.buckets.find((bucket) => bucket.id === inheritBucketId)
      : undefined
  )

  /** The bucket the current choice resolves to, when it resolves to one. */
  let selectedBucket = $derived(
    value.mode === 'scope'
      ? scopeState.boards.get(projectId)?.buckets.find((bucket) => bucket.id === value.bucketId)
      : value.mode === 'inherit'
        ? inheritBucket
        : undefined
  )

  let triggerLabel = $derived(
    value.mode === 'dedicated'
      ? 'Own worktree'
      : value.mode === 'scope'
        ? (selectedBucket?.name ?? 'Chosen scope')
        : (inheritBucket?.name ?? "Sr. Engineer's scope")
  )

  let showWorktree = $derived(selectedBucket?.root.kind === 'worktree')

  function handleSelect(choice: ScopeChoice): void {
    onSelect(choice)
    open = false
  }

  function openCreateScope(): void {
    createModalOpen = true
  }

  onMount(() => {
    void scopeState.ensureBoardLoaded(projectId)
  })
</script>

<div class="flex min-w-0">
  <Popover.Root bind:open>
    <Popover.Trigger
      class="flex min-w-0 items-center gap-1 rounded-lg border bg-elevated px-2 py-1 text-[0.625rem] font-semibold text-muted transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-40"
      aria-label={`Worker scope: ${triggerLabel}`}
      title={`Worker scope: ${triggerLabel}`}
      {disabled}
    >
      {#if showWorktree}
        <FolderTree size={11} class="shrink-0 text-warning" />
      {:else}
        <Folder size={11} class="shrink-0" />
      {/if}
      <span class="min-w-0 truncate">{triggerLabel}</span>
    </Popover.Trigger>

    <Popover.Portal>
      <Popover.Content
        side="top"
        align="start"
        sideOffset={4}
        collisionPadding={12}
        class="z-70"
        role="dialog"
        aria-label="Worker scope"
        tabindex={-1}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onkeydown={(event: KeyboardEvent) => {
          if (event.key === 'Escape') open = false
        }}
      >
        <ScopePickerMenu
          {projectId}
          target={{
            bucket: inheritBucket,
            fallbackName: "Sr. Engineer's scope",
            hint: 'Inherited',
            createLabel: 'New worktree for this worker',
            createHint: 'At dispatch',
            createTitle:
              'Create a git worktree and branch for this worker when its task starts'
          }}
          {value}
          autofocusSearch
          label="Worker scope"
          onSelect={handleSelect}
          onCreateScope={openCreateScope}
          onClose={() => (open = false)}
        />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
</div>

{#if createModalOpen}
  <ScopeCreateModal
    open={createModalOpen}
    {projectId}
    onCreated={(createdId) => handleSelect({ mode: 'scope', bucketId: createdId })}
    onClose={() => (createModalOpen = false)}
  />
{/if}
