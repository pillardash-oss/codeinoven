<script lang="ts">
  import { GitBranch, Loader2, TriangleAlert } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import ScopeSetupCommandsEditor from './ScopeSetupCommandsEditor.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import type { GitBranchInfo, ScopeSetupCommandSpec, ScopeWorktreeSourceInfo } from '$shared/types'

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
  let baseBranch = $state('')
  let localBranches = $state.raw<GitBranchInfo[]>([])
  let branchesLoading = $state(true)
  let branchesError = $state<string | null>(null)
  /** Local branches hidden from the source list because a worktree already holds them. */
  let hiddenWorktreeBranches = $state(0)
  let sourceInfo = $state.raw<ScopeWorktreeSourceInfo | null>(null)
  let error = $state<string | null>(null)
  let busy = $state(false)

  async function loadLocalBranches(getProjectId: () => string): Promise<void> {
    try {
      const branches = (await invoke('git:branches', getProjectId())).filter(
        (branch) => branch.kind === 'local'
      )
      // Git allows a branch in only one worktree, so branches already checked out in a
      // linked worktree are not offered as worktree sources.
      const available = branches.filter((branch) => branch.worktreePath === null)
      hiddenWorktreeBranches = branches.length - available.length
      localBranches = available
      baseBranch = available.find((branch) => branch.current)?.name ?? available[0]?.name ?? ''
      branchesError = available.length > 0 ? null : 'This repository has no local branches.'
    } catch (cause) {
      localBranches = []
      baseBranch = ''
      branchesError = cause instanceof Error ? cause.message : 'Local branches could not be loaded.'
    } finally {
      branchesLoading = false
    }
  }

  /** Seed the form from persisted project-level worktree defaults. */
  async function loadDefaults(): Promise<void> {
    try {
      await scopeState.ensureBoardLoaded(projectId)
    } catch {
      return
    }
    const defaults = scopeState.boards.get(projectId)?.worktreeDefaults
    if (!defaults) return
    runSetup = defaults.runSetupByDefault
    environmentMode = defaults.environmentMode
    setupCommands = defaults.setupCommands.map((command) => ({ ...command }))
  }

  /** Surface the source checkout state so dirty work is not silently skipped. */
  async function loadSourceInfo(): Promise<void> {
    try {
      sourceInfo = await scopeState.worktreeSourceInfo(projectId)
    } catch {
      sourceInfo = null
    }
  }

  void loadLocalBranches(() => projectId)
  void loadDefaults()
  void loadSourceInfo()

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
    if (!trimmed || busy || (isolated && (branchesLoading || !baseBranch))) return
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
        // Persist the entered configuration as project defaults BEFORE creating
        // so the saved defaults can never race ahead of this worktree, then
        // pass the exact snapshot so these commands run for THIS worktree.
        await scopeState.setWorktreeDefaults(projectId, {
          setupCommands,
          runSetupByDefault: runSetup,
          environmentMode
        })
        await scopeState.createWorktree(projectId, bucketId, {
          title: trimmed,
          runSetup,
          environmentMode,
          setupCommands: setupCommands.map((command) => ({ ...command })),
          ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {})
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
          <div class="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
            <label for={`${componentId}-base-branch`} class="shrink-0">Source branch</label>
            <div class="relative min-w-0 flex-1">
              <select
                id={`${componentId}-base-branch`}
                class="h-7 w-full cursor-pointer rounded-md border bg-elevated px-2 pr-7 font-mono text-xs text-foreground outline-none focus:border-primary disabled:cursor-wait disabled:opacity-60"
                title="Local branch the worktree forks from"
                bind:value={baseBranch}
                disabled={branchesLoading || localBranches.length === 0}
                aria-describedby={`${componentId}-base-branch-status`}
              >
                {#if branchesLoading}
                  <option value="">Loading local branches…</option>
                {:else if localBranches.length === 0}
                  <option value="">No local branches</option>
                {:else}
                  {#each localBranches as branch (branch.ref)}
                    <option value={branch.name}>
                      {branch.name}{branch.current ? ' (current)' : ''}
                    </option>
                  {/each}
                {/if}
              </select>
              {#if branchesLoading}
                <Loader2
                  size={12}
                  class="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 animate-spin text-dimmed"
                />
              {/if}
            </div>
          </div>
          {#if branchesError}
            <p id={`${componentId}-base-branch-status`} class="mt-1 text-xs text-danger">
              {branchesError}
            </p>
          {:else if hiddenWorktreeBranches > 0}
            <p id={`${componentId}-base-branch-status`} class="mt-1 text-xs text-muted">
              {hiddenWorktreeBranches}
              {hiddenWorktreeBranches === 1 ? 'branch is' : 'branches are'} already checked out in a worktree
              and cannot be used as a source.
            </p>
          {:else}
            <p id={`${componentId}-base-branch-status`} class="sr-only">
              Only local branches are available as worktree sources.
            </p>
          {/if}
          {#if sourceInfo}
            <p class="text-xs text-dimmed">
              Forks from <span class="text-muted">{baseBranch || sourceInfo.currentBranch}</span>
              at commit <code class="text-muted">{sourceInfo.headCommit.slice(0, 10)}</code>.
            </p>
            {#if sourceInfo.dirtyFiles.length > 0}
              <div
                class="mt-1.5 flex items-start gap-1.5 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning"
                role="status"
              >
                <TriangleAlert size={13} class="mt-0.5 shrink-0" />
                <span>
                  {sourceInfo.dirtyFiles.length} uncommitted change{sourceInfo.dirtyFiles.length ===
                  1
                    ? ''
                    : 's'} in this checkout will not be included — commit them first if they belong in
                  this feature.
                </span>
              </div>
            {/if}
          {/if}
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
      disabled={!name.trim() || busy || (isolated && (branchesLoading || !baseBranch))}
    >
      {busy ? 'Creating…' : 'Create'}
    </button>
  {/snippet}
</Modal>
