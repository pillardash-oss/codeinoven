<script lang="ts">
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'
  import { generateInitialsIconSvg, getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { remoteOriginLabel } from '$lib/project-location'
  import { projectRemotes } from '$lib/stores/project-remotes.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { DEFAULT_SCOPE_BUCKET_ID, type ScopeBucket, type Thread } from '$shared/types'

  interface Props {
    thread: Thread
    /** Whether the harness is currently producing work for this thread. */
    isWorking?: boolean
    /** Human-readable current-stage label shown next to the working badge. */
    stageLabel?: string
    /** Overall thread state used to render the approval stage row. */
    threadState?: 'unread' | 'read' | 'todo' | 'completed' | 'working' | 'approval' | 'error'
  }

  let { thread, isWorking = false, stageLabel = '', threadState = 'read' }: Props = $props()

  /** Project (repo) that owns this thread, resolved for the hover popover. */
  let project = $derived(
    scopeState.projectRecords.find((candidate) => candidate.id === thread.projectId) ?? null
  )

  /** While the sidebar is scoped to one project, Project/Repository are redundant. */
  let hideProjectInfo = $derived(Boolean(scopeState.sidebarContext))

  /** Git remote origin URL for the thread's project, resolved lazily on hover. */
  let remoteOriginUrl = $derived(project ? (projectRemotes.get(project.id) ?? null) : null)

  let scopeBucket = $derived.by((): ScopeBucket | null => {
    const bucketId = scopeState.bucketForThread(thread)
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) return null
    return scopeState.bucketFor(thread.projectId, bucketId)
  })

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

  function formatDate(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  }
</script>

<p class="mb-2 break-words text-sm font-medium text-foreground">{thread.title}</p>
<dl class="space-y-1.5 text-[11px]">
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
  {#if project && !hideProjectInfo}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Project</dt>
      <dd class="min-w-0 break-words text-muted">{project.name}</dd>
    </div>
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Repository</dt>
      <dd class="min-w-0 break-words text-muted" title={remoteOriginUrl ?? project.path}>
        {remoteOriginUrl ? remoteOriginLabel(remoteOriginUrl) : '—'}
      </dd>
    </div>
  {/if}
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Created</dt>
    <dd class="text-muted">{formatDate(thread.createdAt)}</dd>
  </div>
  <div class="flex gap-2">
    <dt class="w-16 shrink-0 text-dimmed">Updated</dt>
    <dd class="text-muted">{formatDate(thread.updatedAt)}</dd>
  </div>
  {#if isWorking}
    <div class="flex gap-2">
      <dt class="w-16 shrink-0 text-dimmed">Stage</dt>
      <dd class="flex items-center gap-1 text-muted">
        <StatusBadge stage="working" animated size="sm" title={stageLabel} />
        {stageLabel}
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
</dl>
