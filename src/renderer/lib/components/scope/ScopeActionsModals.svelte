<script lang="ts">
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import AppearancePicker from '$lib/components/shared/AppearancePicker.svelte'
  import GitSyncPeerDialog from '../git/GitSyncPeerDialog.svelte'
  import ScopeMergeModal from './ScopeMergeModal.svelte'
  import ScopeLifecycleModal from './ScopeLifecycleModal.svelte'
  import ScopeCreateModal from './ScopeCreateModal.svelte'
  import ScopeAdoptModal from './ScopeAdoptModal.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import type { ScopeActionsController } from './ScopeActionsController.svelte'

  interface Props {
    actions: ScopeActionsController
  }

  let { actions }: Props = $props()

  const componentId = $props.id()
  const editFormId = `${componentId}-edit-scope-form`

  let projectId = $derived(actions.projectId)

  /** True while this same scope's removal is already running in the dock. */
  const removing = $derived(
    Boolean(
      projectId && actions.deleteTarget && scopeJobs.isRemoving(projectId, actions.deleteTarget.id)
    )
  )
</script>

<Modal
  open={actions.editTarget !== null}
  title="Edit Scope"
  onClose={() => (actions.editTarget = null)}
>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={() => (actions.editTarget = null)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={editFormId}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={!actions.editName.trim() || scopeState.saving}
    >
      Save
    </button>
  {/snippet}

  <form
    id={editFormId}
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void actions.confirmEdit()
    }}
  >
    <AppearancePicker
      name={actions.editName}
      color={actions.editColor}
      iconType={actions.editIconType}
      onColorChange={(color) => (actions.editColor = color)}
      onIconTypeChange={(iconType) => (actions.editIconType = iconType)}
      onReset={() => {
        actions.editColor = undefined
        actions.editIconType = undefined
      }}
    />
    <div>
      <label
        class="mb-1 block text-xs font-medium text-muted"
        for={`${componentId}-edit-scope-name`}
      >
        Name
      </label>
      <input
        id={`${componentId}-edit-scope-name`}
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
        bind:value={actions.editName}
      />
    </div>
  </form>
</Modal>

<Modal
  open={actions.deleteTarget !== null}
  title="Delete Scope"
  onClose={() => (actions.deleteTarget = null)}
>
  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={() => (actions.deleteTarget = null)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-on-danger hover:bg-danger-hover disabled:cursor-default disabled:opacity-50"
      disabled={removing}
      onclick={() => actions.confirmDelete()}
    >
      {removing ? 'Deleting…' : 'Delete'}
    </button>
  {/snippet}

  <p class="text-sm leading-relaxed text-muted">
    Delete <span class="font-medium text-foreground">{actions.deleteTarget?.name}</span>? {actions.deleteThreads
      ? 'Its threads will be permanently deleted.'
      : 'Its threads will return to Default.'}
    {#if actions.deleteTarget?.root.kind === 'worktree'}
      The worktree and its branch are also removed.
    {/if}
  </p>

  <p class="mt-2 text-xs text-dimmed">
    Removing it runs in the dock, so you can keep working while it finishes.
  </p>

  <div class="mt-4 flex items-center justify-between rounded-lg border bg-elevated/50 px-3 py-2.5">
    <div class="min-w-0">
      <p class="text-sm font-medium text-foreground">Delete associated threads</p>
      <p class="text-xs text-muted">Also permanently delete every thread in this scope.</p>
    </div>
    <Switch
      checked={actions.deleteThreads}
      onchange={(checked) => (actions.deleteThreads = checked)}
      activeClass="bg-danger"
      aria-label="Delete associated threads"
    />
  </div>

  {#if actions.deleteTarget?.root.kind === 'worktree' && actions.deletePreflight}
    <div class="mt-4 space-y-2 text-xs">
      {#if (actions.deletePreflight.dirtyFiles.length ?? 0) > 0}
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-warning">
          <p class="font-medium">
            Uncommitted changes will be lost ({actions.deletePreflight.dirtyFiles.length})
          </p>
          <ul class="mt-1 max-h-24 list-inside list-disc overflow-y-auto">
            {#each actions.deletePreflight.dirtyFiles.slice(0, 20) as file (file)}
              <li class="truncate">{file}</li>
            {/each}
          </ul>
        </div>
      {/if}
      {#if (actions.deletePreflight.unpushedCommits ?? 0) > 0}
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-warning">
          {actions.deletePreflight.unpushedCommits} unpushed commit(s) are not reachable from any remote.
        </div>
      {/if}
      {#if actions.deletePreflight.hasActiveProcesses}
        <div class="rounded-lg border border-warning/30 bg-warning/10 p-3 text-warning">
          Active agent processes are still running in this scope.
        </div>
      {/if}
    </div>
  {/if}
</Modal>

{#if projectId && actions.mergeTarget}
  <ScopeMergeModal
    open
    {projectId}
    sourceBucketId={actions.mergeTarget.id}
    onClose={() => (actions.mergeTarget = null)}
    onDone={() => (actions.mergeTarget = null)}
    onConflicts={(sourceProjectId: string, targetScopeBucketId: string) =>
      actions.openConflictsHandoff(sourceProjectId, targetScopeBucketId)}
  />
{/if}

<!--
  "Merge from project": the same peer chooser the Git panel uses, aimed at this
  scope's worktree. The chooser resolves the running checkout from the scope
  board, so it names this scope as the one the sync runs in.
-->
{#if projectId && actions.syncTarget}
  <GitSyncPeerDialog
    {projectId}
    scopeBucketId={actions.syncTarget.bucket.id}
    initialDirection={actions.syncTarget.direction}
    initialPeer={{ kind: 'root' }}
    onClose={() => (actions.syncTarget = null)}
    onStarted={() => (actions.syncTarget = null)}
  />
{/if}

{#if projectId && actions.lifecycleAction}
  <ScopeLifecycleModal
    open
    {projectId}
    bucketId={actions.lifecycleAction.bucket.id}
    action={actions.lifecycleAction.action}
    onClose={() => (actions.lifecycleAction = null)}
    onDone={() => (actions.lifecycleAction = null)}
  />
{/if}

{#if projectId && actions.createWorktreeTarget}
  <ScopeCreateModal
    open
    {projectId}
    existingBucketId={actions.createWorktreeTarget.id}
    initialName={actions.createWorktreeTarget.name}
    onClose={() => (actions.createWorktreeTarget = null)}
  />
{/if}

{#if projectId && actions.adoptWorktreeTarget}
  <ScopeAdoptModal
    open
    {projectId}
    bucketId={actions.adoptWorktreeTarget.id}
    bucketName={actions.adoptWorktreeTarget.name}
    onClose={() => (actions.adoptWorktreeTarget = null)}
    onAdopted={() => (actions.adoptWorktreeTarget = null)}
  />
{/if}
