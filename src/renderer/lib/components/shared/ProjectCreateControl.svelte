<script lang="ts">
  import {
    AlertTriangle,
    Files,
    FolderInput,
    GitBranch,
    Globe,
    Loader2,
    Plus
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import Modal from '../ui/Modal.svelte'
  import GitCloneModal from './GitCloneModal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { APP_NAME } from '$shared/brand'
  import type { ChangeTrackingMode, Project, RepositoryPreflightResult } from '$shared/types'

  interface Props {
    projects: Project[]
    onProjectCreated: (project: Project) => void | Promise<void>
    onExisting?: (project: Project) => void | Promise<void>
    title?: string
    triggerAddProject?: number
    /** Spotlight mode renders the creation options as a centered dialog instead of the plus dropdown. */
    mode?: 'dropdown' | 'spotlight'
    /** Spotlight mode: controlled visibility. */
    open?: boolean
    onClose?: () => void
  }

  let {
    projects,
    onProjectCreated,
    onExisting,
    title = 'Add project',
    triggerAddProject = 0,
    mode = 'dropdown',
    open = false,
    onClose = () => {}
  }: Props = $props()

  const componentId = $props.id()
  const sshProjectFormId = `${componentId}-ssh-project-form`

  /** React to external trigger (e.g. keyboard shortcut) to start the add-project flow. */
  $effect(() => {
    if (triggerAddProject > 0) {
      void addLocalFolder()
    }
  })
  let showSshModal = $state(false)
  let showGitCloneModal = $state(false)
  let newProjectName = $state('')
  let newProjectHost = $state('')

  let showTrackingModal = $state(false)
  let pendingProjectFolder = $state('')
  let repositoryPreflight = $state<RepositoryPreflightResult | null>(null)
  let trackingSetupBusy = $state(false)
  let trackingSetupError = $state('')

  async function addLocalFolder(): Promise<void> {
    const folder = await invoke('dialog:pickFolder')
    if (!folder) return

    const existing = projects.find((project) => project.path === folder)
    if (existing) {
      await onExisting?.(existing)
      return
    }

    const preflight = await invoke('repository:preflight', folder)
    if (preflight.status === 'git') {
      await createLocalProject(folder, 'git')
      return
    }

    pendingProjectFolder = folder
    repositoryPreflight = preflight
    trackingSetupError = ''
    showTrackingModal = true
  }

  async function createLocalProject(
    folder: string,
    changeTrackingMode: ChangeTrackingMode
  ): Promise<void> {
    const name = folder.split('/').filter(Boolean).pop() ?? folder
    const project = await invoke('project:create', {
      name,
      path: folder,
      source: 'local',
      changeTrackingMode
    })
    await onProjectCreated(project)
  }

  function closeTrackingModal(): void {
    if (trackingSetupBusy) return
    showTrackingModal = false
    pendingProjectFolder = ''
    repositoryPreflight = null
    trackingSetupError = ''
  }

  async function initializeGitAndCreateProject(): Promise<void> {
    if (!pendingProjectFolder || repositoryPreflight?.status === 'git_unavailable') return
    trackingSetupBusy = true
    trackingSetupError = ''
    try {
      const result = await invoke('repository:init', pendingProjectFolder)
      if (result.status !== 'git') {
        trackingSetupError = result.detail ?? 'Git could not be initialized.'
        return
      }
      await createLocalProject(pendingProjectFolder, 'git')
      trackingSetupBusy = false
      closeTrackingModal()
    } catch (error) {
      trackingSetupError = error instanceof Error ? error.message : 'Git could not be initialized.'
    } finally {
      trackingSetupBusy = false
    }
  }

  async function createProjectWithManualTracking(): Promise<void> {
    if (!pendingProjectFolder) return
    trackingSetupBusy = true
    trackingSetupError = ''
    try {
      await createLocalProject(pendingProjectFolder, 'manual')
      trackingSetupBusy = false
      closeTrackingModal()
    } catch (error) {
      trackingSetupError =
        error instanceof Error ? error.message : 'The project could not be added.'
    } finally {
      trackingSetupBusy = false
    }
  }

  function addSshProject(): void {
    showSshModal = true
  }

  function addGitCloneProject(): void {
    showGitCloneModal = true
  }

  async function createSshProject(): Promise<void> {
    if (!newProjectName.trim() || !newProjectHost.trim()) return
    const host = newProjectHost.trim()
    const project = await invoke('project:create', {
      name: newProjectName.trim(),
      path: host,
      source: 'ssh',
      host,
      changeTrackingMode: 'manual'
    })
    await onProjectCreated(project)
    showSshModal = false
    newProjectName = ''
    newProjectHost = ''
  }
</script>

{#if mode === 'dropdown'}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={title}
      {title}
    >
      <Plus size={15} strokeWidth={1.8} />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={6}
        collisionPadding={8}
        class="z-60 w-44 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
      >
        <DropdownMenu.Item
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
          title="Add a folder from this device"
          onSelect={() => void addLocalFolder()}
        >
          <FolderInput size={14} class="shrink-0 text-muted" />
          Local Folder
        </DropdownMenu.Item>
        <DropdownMenu.Item
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
          title="Connect a project over SSH"
          onSelect={addSshProject}
        >
          <Globe size={14} class="shrink-0 text-muted" />
          SSH / Remote
        </DropdownMenu.Item>
        <DropdownMenu.Item
          class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-foreground outline-none transition-colors hover:bg-elevated focus:bg-elevated"
          title="Clone a Git repository"
          onSelect={addGitCloneProject}
        >
          <GitBranch size={14} class="shrink-0 text-muted" />
          Clone Git Repo
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
{:else if open}
  <!-- Spotlight dialog: reachable from any view via Cmd/Ctrl+Shift+N. -->
  <Modal open {onClose} title="Add Project">
    <div class="grid gap-2">
      <button
        type="button"
        class="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-elevated"
        title="Add a folder from this device"
        onclick={() => void addLocalFolder()}
      >
        <FolderInput size={16} class="shrink-0 text-muted" />
        <span>
          <span class="block text-sm font-medium">Local Folder</span>
          <span class="mt-0.5 block text-xs text-dimmed">Add a folder from this device.</span>
        </span>
      </button>
      <button
        type="button"
        class="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-elevated"
        title="Connect a project over SSH"
        onclick={addSshProject}
      >
        <Globe size={16} class="shrink-0 text-muted" />
        <span>
          <span class="block text-sm font-medium">SSH / Remote</span>
          <span class="mt-0.5 block text-xs text-dimmed">Connect a project over SSH.</span>
        </span>
      </button>
      <button
        type="button"
        class="flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-elevated"
        title="Clone a Git repository"
        onclick={addGitCloneProject}
      >
        <GitBranch size={16} class="shrink-0 text-muted" />
        <span>
          <span class="block text-sm font-medium">Clone Git Repo</span>
          <span class="mt-0.5 block text-xs text-dimmed">Clone from https or ssh.</span>
        </span>
      </button>
    </div>
  </Modal>
{/if}

<GitCloneModal
  open={showGitCloneModal}
  onClose={() => (showGitCloneModal = false)}
  onProjectCreated={onProjectCreated}
/>

<Modal open={showSshModal} title="Connect SSH Project" onClose={() => (showSshModal = false)}>
  <form
    id={sshProjectFormId}
    class="space-y-4"
    onsubmit={(event: SubmitEvent) => {
      event.preventDefault()
      void createSshProject()
    }}
  >
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="shared-ssh-name">
        Project Name
      </label>
      <input
        id="shared-ssh-name"
        type="text"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        placeholder="My Remote Project"
        bind:value={newProjectName}
      />
    </div>
    <div>
      <label class="mb-1 block text-xs font-medium text-muted" for="shared-ssh-host">
        Host Name
      </label>
      <input
        id="shared-ssh-host"
        type="text"
        class="w-full rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground placeholder:text-dimmed"
        placeholder="user@192.168.1.10 or myserver.local"
        bind:value={newProjectHost}
      />
      <p class="mt-1 text-xs text-dimmed">{APP_NAME} will connect to this host over SSH.</p>
    </div>
  </form>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      title="Cancel"
      onclick={() => (showSshModal = false)}
    >
      Cancel
    </button>
    <button
      type="submit"
      form={sshProjectFormId}
      class="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-on-primary transition-colors hover:bg-primary-hover"
      title="Connect to this host over SSH"
    >
      Connect
    </button>
  {/snippet}
</Modal>

<Modal open={showTrackingModal} title="Set Up Change Tracking" onClose={closeTrackingModal}>
  <div class="space-y-4">
    <div class="flex gap-3 rounded-xl border bg-elevated p-3">
      <AlertTriangle size={18} class="mt-0.5 shrink-0 text-warning" />
      <div>
        <p class="text-sm font-medium">
          {repositoryPreflight?.status === 'git_unavailable'
            ? 'Git is not available'
            : 'This folder is not a Git repository'}
        </p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Git tracking is more accurate and makes checkpoints, audits, diffs, and rollback easier.
          Manual tracking is available when Git is not appropriate.
        </p>
      </div>
    </div>

    <p
      class="truncate rounded-lg bg-raised px-3 py-2 font-mono text-xs text-muted"
      title={pendingProjectFolder}
    >
      {pendingProjectFolder}
    </p>

    {#if trackingSetupError}
      <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
        {trackingSetupError}
      </p>
    {/if}

    <div class="grid gap-2 sm:grid-cols-2">
      <button
        type="button"
        class="flex items-start gap-2 rounded-xl border p-3 text-left transition-colors hover:bg-elevated disabled:opacity-50"
        disabled={trackingSetupBusy}
        title="Track changes with {APP_NAME} file snapshots"
        onclick={() => void createProjectWithManualTracking()}
      >
        <Files size={16} class="mt-0.5 shrink-0 text-muted" />
        <span>
          <span class="block text-sm font-medium">Track Changes Manually</span>
          <span class="mt-0.5 block text-xs text-dimmed">Use {APP_NAME} file snapshots.</span>
        </span>
      </button>

      <button
        type="button"
        class="flex items-start gap-2 rounded-xl bg-primary p-3 text-left text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
        disabled={trackingSetupBusy || repositoryPreflight?.status === 'git_unavailable'}
        title="Initialize a Git repository in this folder"
        onclick={() => void initializeGitAndCreateProject()}
      >
        {#if trackingSetupBusy}
          <Loader2 size={16} class="mt-0.5 shrink-0 animate-spin" />
        {:else}
          <GitBranch size={16} class="mt-0.5 shrink-0" />
        {/if}
        <span>
          <span class="block text-sm font-medium">Init Git</span>
          <span class="mt-0.5 block text-xs opacity-70">Recommended for reliable rollback.</span>
        </span>
      </button>
    </div>
  </div>

  {#snippet footer()}
    <button
      type="button"
      class="rounded-lg px-3 py-2 text-sm text-muted transition-colors hover:bg-elevated"
      disabled={trackingSetupBusy}
      title="Cancel"
      onclick={closeTrackingModal}
    >
      Cancel
    </button>
  {/snippet}
</Modal>
