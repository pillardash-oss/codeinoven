<script lang="ts">
  /**
   * Bind an assistant task to a project scope, from the task's own row.
   *
   * The task keeps its home on the Assistant view; this only chooses the
   * checkout its runs read and write. Three choices, in the shared scope menu's
   * own vocabulary:
   *
   *   - Assistant storage: no binding at all, which is what a new task has.
   *   - an existing scope on a project's board.
   *   - a new scope, through the same scope creation form the board uses.
   *
   * Rebinding changes where a run's evidence points, so the choice is confirmed
   * before it is applied and the confirmation says exactly that.
   */
  import CioFolderGit from '@pdslng/cio-icon/CioFolderGit.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ScopePickerMenu from '$lib/components/shared/ScopePickerMenu.svelte'
  import ScopeCreateModal from '$lib/components/scope/ScopeCreateModal.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeChoice, type Thread } from '$shared/types'

  interface Props {
    /** The assistant task being bound. Only a task has a home and a scope to tell apart. */
    task: Thread
    open: boolean
    onClose: () => void
    /** The task as the main process stored it after the binding was applied. */
    onBound: (thread: Thread) => void
  }

  let { task, open, onClose, onBound }: Props = $props()

  /** The project whose scopes are being offered; `null` until one is picked. */
  let projectId = $state<string | null>(null)
  /** A choice awaiting confirmation, which is what the footer confirms. */
  let pending = $state<
    { kind: 'bind'; projectId: string; scopeBucketId: string; name: string } | { kind: 'unbind' } | null
  >(null)
  let busy = $state(false)
  let creating = $state(false)

  let bound = $derived(task.boundScope ?? null)

  /** Local projects a task can be bound to, in the user's own order. */
  let projects = $derived(
    [...scopeState.projectRecords].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  )

  $effect(() => {
    if (!open) return
    pending = null
    busy = false
    creating = false
    projectId = bound?.projectId ?? null
  })

  $effect(() => {
    const target = projectId
    if (!open || !target) return
    void scopeState.ensureBoardLoaded(target)
  })

  let board = $derived(projectId ? scopeState.boards.get(projectId) : undefined)

  /** The bucket the menu marks as the inherited choice, when it is on this board. */
  let boundBucket = $derived(
    bound && board ? board.buckets.find((bucket) => bucket.id === bound?.scopeBucketId) : undefined
  )

  let currentChoice = $derived<ScopeChoice>(
    bound && boundBucket
      ? { mode: 'scope', bucketId: boundBucket.id }
      : { mode: 'scope', bucketId: DEFAULT_SCOPE_BUCKET_ID }
  )

  let selectedProject = $derived(projects.find((project) => project.id === projectId) ?? null)

  let confirmCopy = $derived.by(() => {
    if (!pending) return ''
    if (pending.kind === 'unbind') {
      return `This task returns to assistant storage. Runs from then on work in the assistant's own directory, and the evidence of older runs still points at the checkout they actually used.`
    }
    return `This task works in ${pending.name}. Its next runs read and write that checkout, and every receipt, Changes view and Git panel follows it there. A run already recorded keeps pointing at the checkout it ran in.`
  })

  let confirmLabel = $derived(
    pending?.kind === 'unbind' ? 'Unbind' : pending ? 'Bind here' : 'Apply'
  )

  function chooseProject(next: string): void {
    pending = null
    projectId = next
  }

  function selectChoice(choice: ScopeChoice): void {
    const target = projectId
    if (!target) return
    if (choice.mode === 'scope') {
      const name =
        board?.buckets.find((bucket) => bucket.id === choice.bucketId)?.name ?? 'this scope'
      pending = { kind: 'bind', projectId: target, scopeBucketId: choice.bucketId, name }
      return
    }
    // `inherit` means the task stays in the assistant's own storage, which is
    // the honest unbind rather than a binding to a guessed default scope.
    pending = { kind: 'unbind' }
  }

  async function apply(): Promise<void> {
    const choice = pending
    if (!choice || busy) return
    busy = true
    try {
      const updated = await invoke(
        'thread:update',
        task.projectId,
        task.id,
        choice.kind === 'unbind'
          ? { boundScope: undefined }
          : {
              boundScope: {
                projectId: choice.projectId,
                scopeBucketId: choice.scopeBucketId,
                homeProjectId: task.projectId
              }
            }
      )
      scopeState.updateThread(updated)
      onBound(updated)
      onClose()
    } catch (error) {
      reportError(error, 'The task scope could not be changed.')
    } finally {
      busy = false
    }
  }

  function applyPrimary(): void {
    void apply()
  }
</script>

<Modal
  {open}
  title="Task project scope"
  description="Choose the project checkout this assistant task works in."
  size="lg"
  onClose={onClose}
  onEscapeKeydown={(event) => {
    if (creating) {
      event.preventDefault()
      return
    }
    if (pending) {
      event.preventDefault()
      pending = null
    }
  }}
>
  <div class="flex min-h-0 flex-col">
    <div class="flex shrink-0 flex-wrap items-center gap-1 border-b px-3 py-2">
      {#each projects as project (project.id)}
        <button
          type="button"
          class="border px-2 py-1 text-xs transition-colors {projectId === project.id
            ? 'border-border bg-elevated text-foreground'
            : 'border-transparent text-muted hover:bg-elevated hover:text-foreground'}"
          title="Choose {project.name}"
          aria-label="Choose {project.name}"
          aria-pressed={projectId === project.id}
          onclick={() => chooseProject(project.id)}
        >
          {project.name}
        </button>
      {/each}
    </div>

    {#if !projectId}
      <p class="px-3 py-6 text-sm text-muted">
        Choose a project to see the scopes this task can work in.
      </p>
    {:else}
      <div class="relative min-h-0 flex-1">
        <ScopePickerMenu
          projectId={projectId}
          value={currentChoice}
          {busy}
          autofocusSearch
          label="Task project scope"
          target={{
            bucket: boundBucket,
            fallbackName: 'Assistant storage',
            hint: boundBucket ? 'Current scope' : 'No project checkout',
            createLabel: 'New scope',
            createHint: 'This project',
            createTitle: 'Create a new scope on this project and bind the task to it'
          }}
          onSelect={selectChoice}
          onCreateScope={() => {
            creating = true
          }}
          onClose={() => {
            projectId = null
            pending = null
          }}
        />
      </div>
      {#if selectedProject}
        <p class="flex shrink-0 items-center gap-1 border-t px-3 py-2 text-xs text-muted">
          <CioFolderGit size={12} aria-hidden="true" />
          Scopes of {selectedProject.name}
        </p>
      {/if}
    {/if}

    {#if pending}
      <p class="shrink-0 border-t px-3 py-2 text-xs leading-relaxed text-muted">{confirmCopy}</p>
    {/if}
  </div>

  {#snippet footer()}
    <div class="flex items-center justify-between gap-2">
      <button
        type="button"
        class="px-2 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Close without changing the task's scope"
        aria-label="Close without changing the task's scope"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        type="button"
        class="bg-primary px-2 py-1 text-xs text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        title={confirmLabel}
        aria-label={confirmLabel}
        disabled={!pending || busy}
        onclick={applyPrimary}
      >
        {busy ? 'Applying…' : confirmLabel}
      </button>
    </div>
  {/snippet}
</Modal>

{#if creating && projectId}
  <ScopeCreateModal
    open={creating}
    {projectId}
    onClose={() => {
      creating = false
    }}
    onCreated={(bucketId) => {
      creating = false
      const target = projectId
      if (!target) return
      const name = scopeState.boards.get(target)?.buckets.find((b) => b.id === bucketId)?.name
      pending = {
        kind: 'bind',
        projectId: target,
        scopeBucketId: bucketId,
        name: name ?? 'this scope'
      }
    }}
  />
{/if}
