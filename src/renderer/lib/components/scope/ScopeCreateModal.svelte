<script lang="ts">
  import { GitBranch } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import ScopeSetupCommandsEditor from './ScopeSetupCommandsEditor.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { ScopeSetupCommandSpec } from '$shared/types'

  interface Props {
    open: boolean
    projectId: string
    onClose: () => void
    /** Present when creating a worktree for an existing custom scope. */
    existingBucketId?: string | null
    onCreated?: (bucketId: string) => void
  }

  let { open, projectId, onClose, existingBucketId = null, onCreated }: Props = $props()

  const componentId = $props.id()
  const formId = `${componentId}-create-scope-form`

  let name = $state('')
  let isolated = $state(true)
  let runSetup = $state(true)
  let environmentMode = $state<'copy' | 'symlink'>('copy')
  let setupCommands = $state<ScopeSetupCommandSpec[]>([])
  let error = $state<string | null>(null)
  let busy = $state(false)

  $effect(() => {
    // Reset transient state each time the modal opens so stale inputs never leak.
    if (open) {
      name = ''
      error = null
      busy = false
      isolated = true
      runSetup = true
      environmentMode = 'copy'
      setupCommands = []
    }
  })

  /** Preview the collision-safe branch and config-root folder for the title. */
  function previewBranch(): string {
    const slug = name
      .trim()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '')
      .slice(0, 48)
    return `cio/${slug || 'feature'}`
  }

  async function create(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    busy = true
    error = null
    try {
      // For an existing scope we only attach a worktree; otherwise the bucket
      // is created first. Renaming on the migrate path keeps the stable
      // branch/directory (main derives those from the feature title).
      let bucketId = existingBucketId ?? null
      if (!bucketId) {
        const bucket = await scopeState.createBucketForProject(projectId, trimmed)
        bucketId = bucket?.id ?? null
        if (!bucketId) throw new Error('The scope could not be created')
      }
      if (isolated) {
        await scopeState.createWorktree(projectId, bucketId, {
          title: trimmed,
          runSetup,
          environmentMode
        })
      }
      if (setupCommands.length > 0) {
        await scopeState.setWorktreeDefaults(projectId, {
          setupCommands,
          runSetupByDefault: runSetup,
          environmentMode
        })
      }
      onCreated?.(bucketId)
      onClose()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'The scope could not be created.'
    } finally {
      busy = false
    }
  }
</script>

<Modal {open} title="New Scope" size="lg" {onClose}>
  <form
    id={formId}
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void create()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for={`${componentId}-name`}>
        Display name
      </label>
      <input
        id={`${componentId}-name`}
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground"
        placeholder="Feature"
        bind:value={name}
      />
      {#if error}
        <p class="mt-1.5 text-xs text-danger">{error}</p>
      {/if}
    </div>

    <div class="rounded-lg border bg-overlay p-3">
      <Switch bind:checked={isolated} label="Isolated Git worktree">
        <span class="text-xs font-medium text-foreground">Isolated Git worktree</span>
      </Switch>
      <p class="pl-11 text-xs leading-relaxed text-muted">
        {#if isolated}
          A separate checkout on its own <code>cio/</code> branch gives this scope a fully independent
          filesystem. Create this for parallel feature work.
        {:else}
          The scope shares the project directory with the Default scope. Threads and agents here
          intentionally operate on the same files.
        {/if}
      </p>
      {#if isolated}
        <div class="pl-11 pt-2">
          <div class="flex items-center gap-1.5 text-xs text-muted">
            <GitBranch size={13} />
            <code>{previewBranch()}</code>
          </div>
          <p class="text-xs text-dimmed">
            Worktree folder: <code
              >projects/{projectId}/scope/<span class="text-foreground"
                >{name.trim() || 'feature'}</span
              ></code
            > inside the app config directory
          </p>
        </div>
      {/if}
    </div>

    {#if isolated}
      <div class="rounded-lg border bg-overlay p-3">
        <Switch bind:checked={runSetup} label="Run setup scripts">
          <span class="text-xs font-medium text-foreground">Run setup scripts</span>
        </Switch>
      </div>

      <div>
        <p class="mb-1 text-xs font-medium text-muted">Environment files</p>
        <div class="flex items-center gap-4 text-sm">
          <label class="flex items-center gap-1.5">
            <input
              type="radio"
              value="copy"
              checked={environmentMode === 'copy'}
              onchange={() => (environmentMode = 'copy')}
            />
            Copy
          </label>
          <label class="flex items-center gap-1.5">
            <input
              type="radio"
              value="symlink"
              checked={environmentMode === 'symlink'}
              onchange={() => (environmentMode = 'symlink')}
            />
            Symlink
          </label>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          {environmentMode === 'copy'
            ? 'Eligible .env files are copied atomically into the worktree and never overwrite existing files.'
            : 'Environment files are symlinked from the source project root. Not supported on Windows; couples the worktree to the source checkout.'}
        </p>
      </div>

      <ScopeSetupCommandsEditor bind:commands={setupCommands} />
      <p class="text-xs text-dimmed">
        Commands run sequentially with the worktree as their working directory, resolved through the
        shared GUI-safe environment.
      </p>
    {/if}

    <p class="text-xs text-dimmed">
      Renaming a managed scope later changes only its display name; its <code>cio/</code> branch and worktree
      folder stay the same.
    </p>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted hover:bg-elevated"
      onclick={onClose}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={formId}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      disabled={!name.trim() || busy}
    >
      {busy ? 'Creating…' : 'Create'}
    </button>
  {/snippet}
</Modal>
