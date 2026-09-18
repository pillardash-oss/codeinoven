<script lang="ts" module>
  /**
   * Worker threads only: whether the finished task is handed back to the
   * Sr. Engineer for review, or stays a private iteration loop the user drives.
   */
  export interface ComposerWorkerReport {
    /** False when the worker keeps its work private instead of reporting back. */
    enabled: boolean
    /** Applies the choice; the shoe confirms before reporting is switched off. */
    onChange: (enabled: boolean) => void
  }

  /** Everything the composer/host needs to render the scope shoe. */
  export interface ComposerScopeShoe {
    projectId: string
    threadId: string
    bucket: ScopeBucket
    source?: 'local' | 'ssh'
    host?: string
    isNewThread: boolean
    /** While the thread is actively working, scope interactions are inert. */
    isWorking?: boolean
    /** Project identity on the shoe   the project picker stays live only before the first message. */
    project?: ComposerProject
    /** Reassigns the thread's project; only honoured before the first message. */
    onSwitchProject?: (projectId: string) => void
    onOpenScopeView?: () => void | Promise<void>
    /** Worker reporting control; absent on every non-worker thread. */
    report?: ComposerWorkerReport
  }
</script>

<script lang="ts">
  import {
    ChevronDown,
    ClipboardCheck,
    ClipboardX,
    FolderTree,
    Folder,
    Globe,
    GitBranch,
    Monitor
  } from '@lucide/svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import ProjectSwitch from '$lib/components/shared/ProjectSwitch.svelte'
  import ProjectIdentity from '$lib/components/shared/ProjectIdentity.svelte'
  import { hasProjectNameCollision, projectIdentityTitle } from '$lib/project-location'
  import type { ComposerProject } from '$shared/types'
  import ScopeBadge from '$lib/components/shared/ScopeBadge.svelte'
  import ScopePickerMenu from '$lib/components/shared/ScopePickerMenu.svelte'
  import ScopeCreateModal from '$lib/components/scope/ScopeCreateModal.svelte'
  import ChangeScopeModal from '$lib/components/threads/ChangeScopeModal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import { uniqueScopeName } from '$shared/scope-naming'
  import type { ScopeBucket, ScopeChoice, ScopeEnvironmentMode } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
    /** The bucket the thread currently belongs to (default when unset). */
    bucket: ScopeBucket
    /** Where the project runs   scope work targets that box. */
    source?: 'local' | 'ssh'
    host?: string
    /** New threads can reassign the scope; existing ones toggle the scope view. */
    isNewThread: boolean
    /** While the thread is actively working, scope interactions are inert. */
    isWorking?: boolean
    /** Project identity on the shoe   the project picker stays live only before the first message. */
    project?: ComposerProject
    /** Reassigns the thread's project; only honoured before the first message. */
    onSwitchProject?: (projectId: string) => void
    /** Opens the projects/threads scope view for this thread (existing threads). */
    onOpenScopeView?: () => void | Promise<void>
    /** Worker reporting control; absent on every non-worker thread. */
    report?: ComposerWorkerReport
  }

  let {
    projectId,
    threadId,
    bucket,
    source,
    host,
    isNewThread,
    isWorking = false,
    project,
    onSwitchProject,
    onOpenScopeView,
    report
  }: Props = $props()

  let menuOpen = $state(false)
  let creatingAuto = $state(false)
  let createModalOpen = $state(false)
  /** Full change-scope modal, opened by right-clicking the scope badge. */
  let changeScopeOpen = $state(false)
  /** The worker reporting dropdown, and the confirmation that guards turning it off. */
  let reportMenuOpen = $state(false)
  let reportConfirmOpen = $state(false)

  async function assignScope(bucketId: string): Promise<void> {
    try {
      const updated = await invoke('thread:update', projectId, threadId, {
        scopeBucketId: bucketId
      })
      workspaceState.updateThread(updated)
      scopeState.updateThread(updated)
      menuOpen = false
    } catch (error) {
      reportError(error, 'The scope could not be changed.')
    }
  }

  /** Create a scope + isolated worktree in one go; the thread lands in the new
   *  scope and the agent performs its work there with the copy environment. */
  async function autoCreateScope(): Promise<void> {
    if (creatingAuto) return
    creatingAuto = true
    const board = scopeState.boards.get(projectId)
    const candidate = `Auto scope ${board ? board.buckets.length + 1 : 2}`
    // Names are how scopes are referenced, so an auto name must never collide
    // with a renamed or still-present scope on the board.
    const title = uniqueScopeName(
      (board?.buckets ?? []).map((existing) => existing.name),
      candidate
    )
    // The run reports through the app-level worktree dock, so the panel survives
    // this menu closing and the user moving on to the new thread.
    scopeJobs.create(
      projectId,
      {
        title,
        isolated: true,
        runSetup: true,
        environmentMode: 'copy' as ScopeEnvironmentMode
      },
      {
        onCreated: (createdId) => void assignScope(createdId)
      }
    )
    creatingAuto = false
    menuOpen = false
  }

  /**
   * Apply one pick from the shared scope menu: inheriting keeps the thread in
   * its own scope, a dedicated choice defers to the auto-created worktree, and
   * a board scope reassigns the thread to it.
   */
  function selectScope(choice: ScopeChoice): void {
    if (choice.mode === 'inherit') {
      closeMenu()
      return
    }
    if (choice.mode === 'dedicated') {
      void autoCreateScope()
      return
    }
    void assignScope(choice.bucketId)
  }

  function toggleMenu(): void {
    if (!isNewThread) {
      menuOpen = false
      void onOpenScopeView?.()
      return
    }
    if (menuOpen) {
      menuOpen = false
      return
    }
    menuOpen = true
    void scopeState.ensureBoardLoaded(projectId)
  }

  function closeMenu(): void {
    menuOpen = false
  }

  function toggleReportMenu(): void {
    reportMenuOpen = !reportMenuOpen
    if (reportMenuOpen) menuOpen = false
  }

  /**
   * Switching reporting off is destructive: it silently changes what the
   * Sr. Engineer can see, so it confirms first. Switching it back on restores
   * the hand-off and needs no confirmation.
   */
  function selectReport(enabled: boolean): void {
    reportMenuOpen = false
    if (!report || enabled === report.enabled) return
    if (enabled) {
      report.onChange(true)
      return
    }
    reportConfirmOpen = true
  }

  function confirmReportOff(): void {
    reportConfirmOpen = false
    report?.onChange(false)
  }

  /** Git remote origin URL for the project, surfaced on the branch pill. */
  let remoteOriginUrl = $derived(projectRemotes.get(projectId) ?? null)
  let branchPillTitle = $derived(
    remoteOriginUrl ?? (project ? projectIdentityTitle(project) : undefined)
  )
  // Resolve the project's Git remote so hovering the branch pill can reveal it.
  $effect(() => {
    const path = project?.path
    if (!projectId || !path) return
    void projectRemotes.ensure(projectId, path)
  })
</script>

<div class="flex min-w-0 items-center gap-1.5">
  <!-- Project scope -->
  <div class="relative min-w-0">
    <button
      type="button"
      class="flex min-w-0 cursor-pointer items-center gap-1 rounded-md transition-opacity hover:opacity-85"
      aria-haspopup="menu"
      aria-expanded={menuOpen}
      title={isNewThread
        ? `Change the scope of this new thread   currently ${bucket.name}`
        : `Toggle the scoped views for ${bucket.name}`}
      onclick={toggleMenu}
      oncontextmenu={(event: MouseEvent) => {
        event.preventDefault()
        if (isWorking) return
        changeScopeOpen = true
      }}
      aria-disabled={isWorking}
    >
      {#if bucket.root.kind === 'worktree'}
        <span
          class="flex shrink-0 items-center"
          role="img"
          aria-label="Managed Git worktree scope on {bucket.root.branch}"
          title="Managed Git worktree scope on {bucket.root.branch}"
        >
          <FolderTree size={12} class="text-warning" />
        </span>
      {/if}
      <ScopeBadge {bucket} size="sm" />
      {#if isNewThread}
        <span class="shrink-0 text-dimmed">
          <ChevronDown size={11} />
        </span>
      {/if}
    </button>

    {#if changeScopeOpen}
      <ChangeScopeModal
        open={changeScopeOpen}
        {projectId}
        {threadId}
        currentBucketId={bucket.id}
        onClose={() => (changeScopeOpen = false)}
      />
    {/if}

    {#if isNewThread && menuOpen}
      <button
        class="fixed inset-0 z-30 cursor-default"
        aria-label="Close scope menu"
        onclick={closeMenu}
      ></button>
      <div class="absolute bottom-full left-0 z-40 mb-1.5">
        <ScopePickerMenu
          {projectId}
          target={{
            bucket,
            fallbackName: bucket.name,
            hint: 'Inherited',
            createLabel: 'Auto create new scope & worktree',
            createHint: 'Copy env',
            createTitle:
              'Generate a new scope with its own isolated worktree (copy environment)'
          }}
          value={{ mode: 'inherit' }}
          busy={creatingAuto}
          autofocusSearch
          label="Thread scope"
          onSelect={selectScope}
          onCreateScope={() => (createModalOpen = true)}
          onClose={closeMenu}
        />
      </div>
    {/if}
  </div>

  <!-- Project identity: live picker before the first message, show-only after -->
  {#if project}
    <ProjectSwitch
      activeProjectId={projectId}
      onSwitch={isNewThread ? onSwitchProject : undefined}
      disabled={!isNewThread}
      side="top"
      align="start"
      class="shoe-project flex max-w-48 min-w-0 items-center gap-2 justify-start"
      ariaLabel={isNewThread ? 'Change the project of this new thread' : `Project: ${project.name}`}
    >
      {#if project.iconUrl}
        <img src={project.iconUrl} alt="" class="h-4 w-4 shrink-0 rounded" />
      {:else}
        <Folder size={13} class="shrink-0 text-dimmed" />
      {/if}
      <ProjectIdentity
        {project}
        class="shoe-identity min-w-0"
        nameClass="text-xs font-medium text-foreground"
        locationClass="shoe-identity-location text-[0.5625rem] text-dimmed"
        showLocation={hasProjectNameCollision(project, scopeState.projectRecords)}
      />
    </ProjectSwitch>
  {/if}

  <!-- Project type: where the agent's work runs (SSH box support arrives with remote projects) -->
  <span
    class="flex shrink-0 items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted"
    title={source === 'ssh'
      ? `Remote project${host ? ` on ${host}` : ''}   the agent will work on this box`
      : 'Project runs locally on this machine'}
  >
    {#if source === 'ssh'}
      <Globe size={10} class="shrink-0" />
      <span class="max-w-24 truncate">{host ?? 'Remote'}</span>
    {:else}
      <Monitor size={10} class="shrink-0" />
      <span>Local</span>
    {/if}
  </span>

  {#if project?.branch}
    <span
      class="flex min-w-0 shrink items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted"
      title={branchPillTitle}
    >
      <GitBranch size={9} class="shrink-0" />
      <span class="truncate">{project.branch}</span>
    </span>
  {/if}

  <!-- Worker reporting: green while the worker hands its finished task back to
       the Sr. Engineer, amber and bold when it keeps the work private. -->
  {#if report}
    <div class="relative min-w-0 shrink">
      <button
        type="button"
        class="flex min-w-0 max-w-full items-center gap-1 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] whitespace-nowrap transition-colors hover:bg-elevated {report.enabled
          ? 'text-success'
          : 'font-bold text-warning'}"
        aria-haspopup="menu"
        aria-expanded={reportMenuOpen}
        title={report.enabled
          ? 'Reporting is on   this worker reports to the Sr. Engineer when its task is done'
          : 'Reporting is off   this worker will not report to the Sr. Engineer when its task is done'}
        aria-label={report.enabled
          ? 'Worker reporting: on. This worker reports to the Sr. Engineer when its task is done'
          : 'Worker reporting: off. This worker will not report to the Sr. Engineer'}
        onclick={toggleReportMenu}
      >
        {#if report.enabled}
          <ClipboardCheck size={10} class="shrink-0" />
        {:else}
          <ClipboardX size={10} strokeWidth={2.75} class="shrink-0" />
        {/if}
        <span class="shoe-report-label min-w-0 truncate"
          >{report.enabled ? 'Reporting' : 'Not reporting'}</span
        >
      </button>

      {#if reportMenuOpen}
        <button
          class="fixed inset-0 z-30 cursor-default"
          aria-label="Close worker reporting menu"
          onclick={() => (reportMenuOpen = false)}
        ></button>
        <div
          class="absolute bottom-full right-0 z-40 mb-1.5 w-60 rounded-xl border bg-surface p-1.5 shadow-lg"
          role="menu"
          aria-label="Worker reporting"
        >
          <p
            class="px-2.5 pt-1 pb-0.5 text-[0.5625rem] font-semibold tracking-wide text-dimmed uppercase"
          >
            Worker reports their work
          </p>
          <p class="px-2.5 pb-1.5 text-[0.625rem] leading-snug text-muted">
            Report to the Sr. Engineer when the task is done so it can audit the thread.
          </p>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-elevated {report.enabled
              ? 'font-medium text-success'
              : 'text-muted'}"
            title="Report to the Sr. Engineer when the task is done"
            aria-label="Report to the Sr. Engineer when the task is done"
            role="menuitemradio"
            aria-checked={report.enabled}
            onclick={() => selectReport(true)}
          >
            <ClipboardCheck size={12} class="shrink-0 text-success" />
            Report
          </button>
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-elevated {report.enabled
              ? 'text-muted'
              : 'font-bold text-warning'}"
            title="Never report to the Sr. Engineer, so no review or audit is triggered"
            aria-label="Never report to the Sr. Engineer"
            role="menuitemradio"
            aria-checked={!report.enabled}
            onclick={() => selectReport(false)}
          >
            <ClipboardX size={12} strokeWidth={2.75} class="shrink-0 text-warning" />
            Don't report
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<ConfirmDialog
  open={reportConfirmOpen}
  title="Stop reporting to the Sr. Engineer?"
  confirmLabel="Turn off report"
  cancelLabel="Cancel"
  onCancel={() => (reportConfirmOpen = false)}
  onConfirm={confirmReportOff}
>
  <p>
    This worker will not report to the Sr. Engineer that it is done, so the Sr. Engineer will not
    audit the thread to confirm it is aligned with the Assignment.
  </p>
  <p>
    The task stays with you instead: keep iterating on this thread and turn reporting back on when
    you want the Sr. Engineer to review and audit the finished work.
  </p>
</ConfirmDialog>

{#if createModalOpen}
  <ScopeCreateModal
    open={createModalOpen}
    {projectId}
    onCreated={(createdId) => void assignScope(createdId)}
    onClose={() => (createModalOpen = false)}
  />
{/if}

<style>
  /* The shoe card is the container: as the conversation screen shrinks (e.g.
     a very wide right sidebar), give the truncating stages room in order  
     project name first, then location, connection label, and finally only the
     icons remain. */

  /* The reporting pill reserves the width of its widest label so flipping the
     switch never shifts the row, and truncates once the shoe runs out of room. */
  .shoe-report-label {
    min-width: 4.5rem;
  }

  @container (max-width: 400px) {
    .shoe-project {
      max-width: 8rem;
    }

    .shoe-identity :global(.shoe-identity-location) {
      display: none;
    }

    .shoe-report-label {
      min-width: 0;
      max-width: 3.5rem;
    }
  }

  @container (max-width: 320px) {
    .shoe-project {
      max-width: 1.25rem;
    }

    .shoe-identity {
      display: none;
    }

    .shoe-report-label {
      display: none;
    }
  }
</style>
