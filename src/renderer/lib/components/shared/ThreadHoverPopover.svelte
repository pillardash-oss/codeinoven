<script lang="ts">
  import { AppWindow, Clock, GitBranch } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { feature } from '$lib/feature-registry'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { generateInitialsIconSvg, getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { remoteOriginLabel } from '$lib/project-location'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import { ovens } from '$lib/stores/ovens.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { threadNotesState } from '$lib/stores/thread-notes.svelte'
  import { threadScopeBucket } from '$lib/threads/thread-scope'
  import { formatDateTime } from '$shared/date-time-format'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import type { Thread } from '$shared/types'

  interface Props {
    thread: Thread
    /** Whether the harness is currently producing work for this thread. */
    isWorking?: boolean
    /** Human-readable current-stage label shown next to the working badge. */
    stageLabel?: string
    /** Whether the provider is waiting for an automatic retry. */
    isRetryPaused?: boolean
    /** Whether this thread's in-flight turn belongs to another CodeInOven
     *  instance, which is where its live output and stop control are. */
    isForeignRun?: boolean
    /**
     * Force-hide the Project/Repository rows. Assistant tasks live in the
     * hidden assistant container, so its internal project is noise here.
     */
    hideProject?: boolean
    /** Overall thread state used to render the approval stage row. */
    threadState?:
      | 'unread'
      | 'temporary-unread'
      | 'read'
      | 'todo'
      | 'completed'
      | 'working'
      | 'working-paused'
      | 'spec'
      | 'approval'
      | 'error'
      | 'scheduled'
  }

  let {
    thread,
    isWorking = false,
    isRetryPaused = false,
    isForeignRun = false,
    hideProject = false,
    stageLabel = '',
    threadState = 'read'
  }: Props = $props()

  /** Project (repo) that owns this thread, resolved for the hover popover. */
  let project = $derived(
    scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
  )

  /** While the sidebar is scoped to one project, Project/Repository are redundant. */
  let showProjectInfo = $derived(!hideProject && !scopeState.sidebarContext)

  /** Git remote origin URL for the thread's project, resolved lazily on hover. */
  let remoteOriginUrl = $derived(project ? (projectRemotes.get(project.id) ?? null) : null)

  let scopeBucket = $derived(threadScopeBucket(thread))

  /** Oven the thread runs on, or null when it runs on this computer. */
  let oven = $derived(
    thread.settings?.ovenId && thread.settings.ovenId !== LOCAL_OVEN_ID
      ? ovens.identity(thread.settings.ovenId)
      : null
  )

  /** Git branch the thread's checkout is on, when main resolved one. */
  let branch = $derived(thread.branch?.trim() || null)

  /** Every harness this thread's session used, newest first. The row truncates
   *  this list; the card is where the whole set is readable. */
  let harnessIds = $derived.by((): string[] => {
    const ids = Array.from(new Set(thread.usedHarnessIds ?? []))
    if (thread.settings?.harnessId && !ids.includes(thread.settings.harnessId))
      return [...ids, thread.settings.harnessId]
    return ids
  })

  function harnessLabel(harnessId: string): string {
    return getAgentIcon(harnessId)?.name ?? harnessId
  }

  let scopeColor = $derived(
    scopeBucket ? (scopeBucket.color ?? pickColorForSeed(scopeBucket.id)) : ''
  )

  let scopeIconUrl = $derived.by((): string | null => {
    if (!scopeBucket) return null
    if (scopeBucket.iconType) return getIconSvgDataUrl(scopeBucket.iconType, scopeColor)
    if (scopeBucket.color) return generateInitialsIconSvg(scopeBucket.name, scopeColor)
    return null
  })

  $effect(() => {
    if (project?.source === 'local' && project.path) {
      void projectRemotes.ensure(project.id, project.path)
    }
  })

  $effect(() => {
    if (thread.settings?.ovenId && thread.settings.ovenId !== LOCAL_OVEN_ID) void ovens.ensure()
  })
</script>

<p class="mb-2 break-words text-sm font-medium text-foreground">{thread.title}</p>
<dl class="space-y-1.5 text-[0.6875rem]">
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">ID</dt>
    <dd class="min-w-0 select-all break-all font-mono text-muted" title={thread.id}>
      {thread.id}
    </dd>
  </div>
  {#if scopeBucket}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Scope</dt>
      <dd class="flex min-w-0 items-center gap-1 text-muted">
        {#if scopeIconUrl}
          <img
            src={scopeIconUrl}
            alt=""
            class="h-3 w-3 shrink-0 object-contain"
            draggable="false"
          />
        {/if}
        <span class="min-w-0 break-words">{scopeBucket.name}</span>
      </dd>
    </div>
  {/if}
  {#if oven}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Oven</dt>
      <dd class="flex min-w-0 items-center gap-1 text-muted">
        {#if oven.iconUrl}
          <img
            src={oven.iconUrl}
            alt=""
            class="h-3 w-3 shrink-0 object-contain"
            draggable="false"
          />
        {/if}
        <span class="min-w-0 break-words">{oven.name}</span>
      </dd>
    </div>
  {/if}
  {#if branch}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Branch</dt>
      <dd class="flex min-w-0 items-center gap-1 text-muted">
        <GitBranch size={11} class="shrink-0" aria-hidden="true" />
        <span class="min-w-0 break-words font-mono">{branch}</span>
      </dd>
    </div>
  {/if}
  {#if oven && thread.settings?.ovenPath}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Checkout</dt>
      <dd
        class="min-w-0 break-all font-mono text-[0.625rem] text-muted"
        title={thread.settings.ovenPath}
      >
        {thread.settings.ovenPath}
      </dd>
    </div>
  {/if}
  {#if harnessIds.length > 0}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Harnesses</dt>
      <dd class="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-muted">
        {#each harnessIds as harnessId (harnessId)}
          <span class="flex min-w-0 items-center gap-1">
            <AgentIcon agentId={harnessId} label={harnessLabel(harnessId)} size={14} />
            <span class="truncate">{harnessLabel(harnessId)}</span>
          </span>
        {/each}
      </dd>
    </div>
  {/if}
  {#if project && showProjectInfo}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Project</dt>
      <dd class="min-w-0 break-words text-muted">{project.name}</dd>
    </div>
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Repo</dt>
      <dd class="min-w-0 break-words text-muted" title={remoteOriginUrl ?? project.path}>
        {remoteOriginUrl ? remoteOriginLabel(remoteOriginUrl) : ' '}
      </dd>
    </div>
  {/if}
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Created</dt>
    <dd class="text-muted">{formatDateTime(thread.createdAt)}</dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Updated</dt>
    <dd class="text-muted">{formatDateTime(thread.updatedAt)}</dd>
  </div>
  {#if isForeignRun}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
      <dd class="flex items-center gap-1 text-muted">
        <StatusBadge
          stage="working"
          variant="icon"
          icon={AppWindow}
          size="sm"
          title="Running in another instance"
        />
        Running in another instance
      </dd>
    </div>
  {:else if isWorking}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
      <dd class="flex items-center gap-1 text-muted">
        <StatusBadge stage="working" animated size="sm" title={stageLabel} />
        {stageLabel}
      </dd>
    </div>
  {/if}
  {#if threadState === 'scheduled'}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
      <dd class="flex items-center gap-1" style="color: var(--color-thread-working)">
        <StatusBadge
          stage="working"
          variant="icon"
          icon={Clock}
          size="sm"
          title="Waiting for dependencies"
        />
        Waiting for dependencies
      </dd>
    </div>
  {/if}
  {#if isRetryPaused}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
      <dd class="flex items-center gap-1 text-warning">
        <StatusBadge tone="working-paused" variant="spinner" size="sm" title="Waiting to retry" />
        Waiting to retry
      </dd>
    </div>
  {/if}
  {#if threadState === 'approval'}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
      <dd class="flex items-center gap-1 text-warning">
        <StatusBadge kind="attention" animated size="sm" title="Needs Attention" />
        Needs Attention
      </dd>
    </div>
  {/if}
  {#if threadState === 'spec'}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
      <dd class="flex items-center gap-1" style="color: var(--color-thread-spec)">
        <StatusBadge stage="spec" size="sm" title="Spec ready" />
        Spec ready
      </dd>
    </div>
  {/if}
  {#if threadNotesState.has(thread.id)}
    {@const ThreadNoteIcon = feature('thread-note').icon}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Note</dt>
      <dd class="flex items-center gap-1 text-warning" title="This thread has a user note">
        <ThreadNoteIcon size={12} />
        {feature('thread-note').name} available
      </dd>
    </div>
  {/if}
</dl>
