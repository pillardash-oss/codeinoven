<script lang="ts" module>
  // Aliased: this file also imports the component itself, and the type is the
  // union the component renders while the value is the component.
  import type { ComposerIdentity as ComposerIdentityData } from './ComposerIdentity.svelte'

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

  /**
   * The scope segment's data. Only a project thread has a scope: a chat, a
   * routine task and a browser conversation have no board to belong to.
   */
  export interface ComposerScope {
    projectId: string
    threadId: string
    bucket: ScopeBucket
    /** New threads can reassign the scope; existing ones toggle the scope view. */
    isNewThread: boolean
    /** Opens the projects/threads scope view for this thread (existing threads). */
    onOpenScopeView?: () => void | Promise<void>
  }

  /**
   * What the context holds, as the shoe states it: the five-cell meter and its
   * number, drawn by `ContextUsageIndicator` before the tips. The composer owns
   * this reading, so it does not travel through `ComposerShoeData`, which the
   * host builds.
   */
  export interface ComposerUsage {
    usage?: AgentContextUsage
    efficiencyKpis?: UsageEfficiencyKpis
    harnessUsage?: AgentHarnessUsage[]
    canCompact?: boolean
    compacting?: boolean
    onCompact?: () => void
    onActivateBankedReset?: () => void
    onReveal?: () => void
    onHide?: () => void
    refreshing?: boolean
  }

  /**
   * Everything the shoe states about one composer, in the order it renders:
   * what the composer writes into, the scope it belongs to (projects), the Oven
   * the work runs on, and   inside `identity`   the branch. This is the whole
   * contract: every composer in the app renders the same shoe, and a surface the
   * shoe cannot name yet is a missing `ComposerIdentity` member, not a new bar.
   */
  export interface ComposerShoeData {
    /** What this composer writes into, which names and marks the identity segment. */
    identity: ComposerIdentityData
    /** Project threads only. */
    scope?: ComposerScope
    /** While a turn streams, scope interactions are inert and the tips gain the
     *  steer key. */
    isWorking?: boolean
    /** The Oven segment, rendered by the host through a snippet it owns. */
    oven?: import('svelte').Snippet
    /** Opens the Oven picker from a slash command or palette action. */
    onOpenOven?: () => void
    /** Worker threads only. */
    report?: ComposerWorkerReport
  }
</script>

<script lang="ts">
  import { trackEscapeMenu } from '$lib/overlay-close.svelte'
  import { ChevronDown, ClipboardCheck, ClipboardX, FolderTree, GitBranch } from '@lucide/svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { projectIdentityTitle } from '$lib/project-location'
  import type { ScopeBucket, ScopeChoice, ScopeEnvironmentMode } from '$shared/types'
  import type { AgentContextUsage, AgentHarnessUsage, UsageEfficiencyKpis } from '$shared/types'
  import ScopeBadge from '$lib/components/shared/ScopeBadge.svelte'
  import ScopePickerMenu from '$lib/components/shared/ScopePickerMenu.svelte'
  import ScopeCreateModal from '$lib/components/scope/ScopeCreateModal.svelte'
  import ChangeScopeModal from '$lib/components/threads/ChangeScopeModal.svelte'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import ShortcutHint from '$lib/components/ui/ShortcutHint.svelte'
  import ComposerIdentity from './ComposerIdentity.svelte'
  import ContextUsageIndicator from './ContextUsageIndicator.svelte'
  import { uniqueScopeName } from '$shared/scope-naming'

  interface Props {
    shoe: ComposerShoeData
    /**
     * The composer's own reading: context and quota. Required, because the
     * battery is always on screen   it is how the user checks a model choice
     * before sending, and hovering it is what fetches live quota.
     */
    usage: ComposerUsage
    /** Runs whenever the scope picker menu closes, so the composer that renders
     *  the shoe can win its focus back and resume typing at the saved caret. */
    onScopeMenuClosed?: () => void
  }

  let { shoe, usage, onScopeMenuClosed }: Props = $props()

  /** The project this thread belongs to, whichever way the shoe learned it. */
  let projectId = $derived(
    shoe.identity.kind === 'project' ? shoe.identity.activeProjectId : (shoe.scope?.projectId ?? '')
  )
  let threadId = $derived(shoe.scope?.threadId ?? '')
  let bucket = $derived(shoe.scope?.bucket)
  let isNewThread = $derived(shoe.scope?.isNewThread ?? false)
  let isWorking = $derived(shoe.isWorking ?? false)
  let project = $derived(shoe.identity.kind === 'project' ? shoe.identity.project : undefined)
  /** Worker reporting is the one control the shoe states besides the identity. */
  let report = $derived(shoe.report)

  let menuOpen = $state(false)
  let creatingAuto = $state(false)
  let createModalOpen = $state(false)
  /**
   * Thread the full creation form was opened for. Frozen at open time because
   * the docked run outlives this shoe and the props keep tracking the selected
   * thread, so assigning on completion must never read them back.
   */
  let createTarget: { projectId: string; threadId: string } | null = $state(null)
  /** Full change-scope modal, opened by right-clicking the scope badge. */
  let changeScopeOpen = $state(false)
  /** The worker reporting dropdown, and the confirmation that guards turning it off. */
  let reportMenuOpen = $state(false)
  let reportConfirmOpen = $state(false)

  trackEscapeMenu(() => menuOpen, closeMenu)
  trackEscapeMenu(
    () => reportMenuOpen,
    () => {
      reportMenuOpen = false
    }
  )

  async function assignScopeToThread(
    targetProjectId: string,
    targetThreadId: string,
    bucketId: string
  ): Promise<void> {
    try {
      const updated = await invoke('thread:update', targetProjectId, targetThreadId, {
        scopeBucketId: bucketId
      })
      workspaceState.updateThread(updated)
      scopeState.updateThread(updated)
      closeMenu()
    } catch (error) {
      reportError(error, 'The scope could not be changed.')
    }
  }

  async function assignScope(bucketId: string): Promise<void> {
    await assignScopeToThread(projectId, threadId, bucketId)
  }

  /** Freeze the creation target and open the full scope form. */
  function openCreateModal(): void {
    createTarget = { projectId, threadId }
    createModalOpen = true
  }

  /** Apply a freshly created scope to the thread the form was opened for. */
  function assignCreatedScope(bucketId: string): void {
    const target = createTarget
    createTarget = null
    if (!target) {
      void assignScope(bucketId)
      return
    }
    void assignScopeToThread(target.projectId, target.threadId, bucketId)
  }

  /** Create a scope + isolated worktree in one go; the thread lands in the new
   *  scope and the agent performs its work there with the copy environment. */
  async function autoCreateScope(): Promise<void> {
    if (creatingAuto) return
    creatingAuto = true
    // Freeze the initiating thread: the run outlives this menu and the props
    // keep tracking the selected thread, so reading them on completion would
    // move whichever thread the user switched to instead of this one.
    const targetProjectId = projectId
    const targetThreadId = threadId
    const board = scopeState.boards.get(targetProjectId)
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
      targetProjectId,
      {
        title,
        isolated: true,
        runSetup: true,
        environmentMode: 'copy' as ScopeEnvironmentMode
      },
      {
        targetThreadId,
        onCreated: (createdId) =>
          void assignScopeToThread(targetProjectId, targetThreadId, createdId)
      }
    )
    creatingAuto = false
    closeMenu()
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
      void shoe.scope?.onOpenScopeView?.()
      return
    }
    if (menuOpen) {
      closeMenu()
      return
    }
    openScopeMenu()
  }

  /** Opens the scope picker for callers that already know it is live (the
   *  composer's `/scope` slash action); inert on existing or working threads. */
  export function openScopeMenu(): void {
    if (!isNewThread || isWorking) return
    menuOpen = true
    void scopeState.ensureBoardLoaded(projectId)
  }

  /** The single close path for the scope menu: every dismissal   Escape, a
   *  pick, the click-away overlay, or toggling the shoe again   routes through
   *  here so the composer's focus restoration sees exactly one transition. */
  function closeMenu(): void {
    if (!menuOpen) return
    menuOpen = false
    onScopeMenuClosed?.()
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
  let branchTitle = $derived(
    remoteOriginUrl ?? (project ? projectIdentityTitle(project) : undefined)
  )
  // Resolve the project's Git remote so hovering the branch reveals it.
  $effect(() => {
    const path = project?.path
    if (!projectId || !path) return
    void projectRemotes.ensure(projectId, path)
  })
</script>

<div class="flex min-w-0 items-center gap-px whitespace-nowrap">
  <!-- Scope: the board the thread belongs to. Project threads only. -->
  {#if bucket}
    <div class="relative min-w-0">
      <button
        type="button"
        class="group flex h-6 min-w-0 shrink cursor-pointer items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
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
        <ScopeBadge {bucket} size="sm" variant="mark" />
        {#if isNewThread}
          <span
            class="shrink-0 text-dimmed transition-transform duration-200 group-hover:text-foreground group-aria-expanded:rotate-180 group-aria-expanded:text-foreground"
          >
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
              createTitle: 'Generate a new scope with its own isolated worktree (copy environment)'
            }}
            value={{ mode: 'inherit' }}
            busy={creatingAuto}
            autofocusSearch
            label="Thread scope"
            onSelect={selectScope}
            onCreateScope={openCreateModal}
            onClose={closeMenu}
          />
        </div>
      {/if}
    </div>
  {/if}

  <!-- What this composer writes into: a project, a plain chat, a routine, a task,
       or the browser tab a conversation answers about. -->
  <ComposerIdentity identity={shoe.identity} />

  {#if shoe.oven}
    <!-- One hairline separates what the work is from where it runs. -->
    <span class="mx-1 h-3 w-px shrink-0 bg-border-strong" aria-hidden="true"></span>
    {@render shoe.oven()}
  {/if}

  {#if project?.branch}
    <span
      class="flex h-6 min-w-0 shrink items-center gap-1.5 px-1.5 text-[0.6875rem] text-muted"
      title={branchTitle}
    >
      <GitBranch size={11} class="shrink-0 text-dimmed" />
      <span class="shoe-branch-label truncate">{project.branch}</span>
    </span>
  {/if}

  <!-- Worker reporting: green while the worker hands its finished task back to
       the Sr. Engineer, amber when it keeps the work private. -->
  {#if report}
    <div class="relative min-w-0 shrink">
      <button
        type="button"
        class="flex h-6 min-w-0 max-w-full shrink items-center gap-1.5 px-1.5 text-[0.6875rem] whitespace-nowrap transition-colors hover:bg-elevated {report.enabled
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
          <ClipboardCheck size={12} class="shrink-0" />
        {:else}
          <ClipboardX size={12} strokeWidth={2.75} class="shrink-0" />
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
          class="absolute bottom-full right-0 z-40 mb-1.5 w-60 border bg-surface p-1.5 shadow-lg"
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
            class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-elevated {report.enabled
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
            class="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-elevated {report.enabled
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

  <!-- What the context holds, before the keys: the composer's own reading, in the
       row the composer already owns, so the toolbar above keeps its room. It is
       never hidden: a thread with no reading yet still shows the gauge, which is
       what the user hovers to check usage before sending. Its popover opens over
       the composer it belongs to. -->
  <ContextUsageIndicator
    usage={usage.usage}
    efficiencyKpis={usage.efficiencyKpis}
    harnessUsage={usage.harnessUsage ?? []}
    canCompact={usage.canCompact ?? false}
    compacting={usage.compacting ?? false}
    onCompact={usage.onCompact}
    onActivateBankedReset={usage.onActivateBankedReset}
    onReveal={usage.onReveal}
    onHide={usage.onHide}
    refreshing={usage.refreshing ?? false}
  />

  <!-- The tips: the keys that end a message, there only to be read. Nothing here
       lights up, because there is nothing to pick, and they are the first thing
       the row gives up when the composer tightens. -->
  <span class="shoe-tips flex h-6 shrink-0 items-center gap-1.5 px-2">
    <ShortcutHint keys={keymapState.keysFor('chat-send')} />
    <span class="shoe-tip-text text-[0.625rem] tracking-[0.02em] text-dimmed">send</span>
    {#if isWorking}
      <ShortcutHint keys={keymapState.keysFor('chat-steer')} />
      <span class="shoe-tip-text text-[0.625rem] tracking-[0.02em] text-dimmed">steer</span>
    {/if}
  </span>
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
    targetThreadId={createTarget?.threadId ?? threadId}
    onCreated={(createdId) => assignCreatedScope(createdId)}
    onClose={() => (createModalOpen = false)}
  />
{/if}

<style>
  /* The shoe wrapper is the query container (`.composer-shoe` carries the
     `@container` class), so every threshold below is a width of the room the
     composer leaves that wrapper: the composer, less the wrapper's own inline
     padding. As the composer tightens, give the truncating stages room in
     order   the tips first (they are read once), then the branch and the worker
     label, then the scope and Oven names, and the identity is what holds out
     longest.

     The scope badge and the Oven's label are drawn by child components, so only
     `:global(...)` reaches them from here. `shoe-branch-label`, `shoe-report-label`
     and `shoe-tips` are this component's own markup and stay scoped. */

  /* The reporting pill reserves the width of its widest label so flipping the
     switch never shifts the row, and truncates once the shoe runs out of room. */
  .shoe-report-label {
    min-width: 4.5rem;
  }

  @container (max-width: 700px) {
    :global(.shoe-project) {
      max-width: 9rem;
    }

    :global(.scope-badge-label) {
      max-width: 7rem;
    }

    .shoe-branch-label {
      max-width: 6rem;
    }

    .shoe-report-label {
      min-width: 0;
      max-width: 4.5rem;
    }
  }

  @container (max-width: 610px) {
    .shoe-branch-label,
    .shoe-report-label {
      display: none;
    }

    :global(.shoe-identity-location) {
      display: none;
    }
  }

  /* The keys are a courtesy, not a control: they go before any name does. */
  @container (max-width: 520px) {
    .shoe-tips {
      display: none;
    }
  }

  /* Names give way to marks. The scope keeps its colour bar and the Oven keeps
     its own icon, so both still say which one they are for anyone who hovers. */
  @container (max-width: 420px) {
    :global(.scope-badge-label),
    :global(.oven-segment-label) {
      display: none;
    }
  }
</style>
