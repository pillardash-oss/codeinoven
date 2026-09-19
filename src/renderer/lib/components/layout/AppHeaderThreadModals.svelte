<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import ThreadDeleteConfirm from '$lib/components/ui/ThreadDeleteConfirm.svelte'
  import ChangeScopeModal from '$lib/components/threads/ChangeScopeModal.svelte'
  import { createThreadActionsMenu } from '$lib/components/shared/thread-actions-menu.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'

  interface Props {
    /** Shared thread action menu owned by the header shell. */
    menu: ReturnType<typeof createThreadActionsMenu>
  }

  let { menu }: Props = $props()
</script>

<!-- Thread Rename Modal -->
<Modal open={menu.showRenameModal} title="Rename Thread" onClose={menu.cancelRename}>
  <form
    id="header-thread-rename-form"
    class="space-y-4"
    onsubmit={(e: SubmitEvent) => {
      e.preventDefault()
      void menu.confirmRename()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="rename-input">Title</label>
      <input
        id="rename-input"
        type="text"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        bind:value={menu.renameValue}
      />
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={menu.cancelRename}
    >
      Cancel
    </button>
    <button
      type="submit"
      form="header-thread-rename-form"
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      disabled={!menu.renameValue.trim()}
      title="Save the new title"
    >
      Save
    </button>
  {/snippet}
</Modal>

<!-- Thread Delete Confirmation -->
{#if workspaceState.selectedThread}
  <ThreadDeleteConfirm
    open={menu.showDeleteModal}
    threadTitle={workspaceState.selectedThread.title}
    onClose={menu.cancelDelete}
    onConfirm={menu.confirmDelete}
  />
{/if}

<!-- Change Scope Modal -->
{#if menu.showChangeScopeModal}
  {@const thread = workspaceState.selectedThread}
  {@const currentBucketId = thread?.scopeBucketId ?? 'default'}
  <ChangeScopeModal
    open={menu.showChangeScopeModal}
    onClose={menu.cancelChangeScope}
    threadId={thread?.id ?? ''}
    projectId={thread?.projectId ?? ''}
    {currentBucketId}
  />
{/if}
