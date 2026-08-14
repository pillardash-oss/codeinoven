<script lang="ts">
  import {
    CircleCheck,
    CircleX,
    Clock3,
    Cloud,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Rocket,
    Search,
    Server,
    Trash2
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { cloudDeployState, CloudDeployState } from '$lib/stores/cloud-deploy.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import CloudProviderIcon from './icons/CloudProviderIcon.svelte'
  import Modal from '../ui/Modal.svelte'
  import { DEFAULT_THREAD_TITLE } from '$shared/types'
  import EmptyState from '../ui/EmptyState.svelte'
  import StatusPill, { type StatusTone } from '../ui/StatusPill.svelte'
  import Switch from '../ui/Switch.svelte'
  import CloudDeploymentConfigSheet from './CloudDeploymentConfigSheet.svelte'
  import CloudDeploymentDetail from './CloudDeploymentDetail.svelte'
  import ContainerLinksMenu from './ContainerLinksMenu.svelte'
  import {
    type CloudDeploymentConfig,
    type CloudDeploymentContainer,
    type CloudDeploymentProviderKind
  } from '$shared/types'

  interface Props {
    projectId: string
    threadId: string
  }

  let { projectId }: Props = $props()

  const PROVIDER_LABELS: Record<CloudDeploymentProviderKind, string> = {
    coolify: 'Coolify',
    netlify: 'Netlify',
    railway: 'Railway',
    vercel: 'Vercel',
    dokploy: 'Dokploy',
    custom: 'Custom'
  }

  /** When set, the in-app detail view replaces the container list. */
  let selectedContainer = $state<CloudDeploymentContainer | null>(null)

  let config = $state<CloudDeploymentConfig | null>(null)
  let configLoading = $state(true)
  let error = $state('')

  /** Auto-revalidate statuses while mounted. */
  let liveUpdates = $state(true)

  let searchQuery = $state('')
  let statusFilter = $state<'all' | CloudDeploymentContainer['status']>('all')

  // Configuration sheet state. Both the add-provider and add-container flows
  // live in the shared CloudDeploymentConfigSheet; the panel only picks which
  // mode it opens in.
  let configSheetOpen = $state(false)
  let configSheetMode = $state<'provider' | 'container'>('provider')
  /** Container being edited (pre-filled into the config sheet), or null to add. */
  let editingContainer = $state<CloudDeploymentContainer | null>(null)
  /** Container awaiting delete confirmation (destructive action). */
  let deleteTarget = $state<CloudDeploymentContainer | null>(null)

  const providers = $derived(config?.project.providers ?? [])

  const configured = $derived(providers.length > 0)

  function openConfigSheet(mode: 'provider' | 'container'): void {
    configSheetMode = mode
    configSheetOpen = true
  }

  async function handleConfigSaved(): Promise<void> {
    await loadConfig()
    if (configured) await refreshAll()
  }

  /**
   * All configured containers, flattened across providers and deduped by key.
   * The overview's merged snapshot supplies the base (including the project's
   * custom label); the authoritative per-container status fetched during
   * automatic monitoring is overlaid on top so build status changes show up
   * without a manual reload. Only the authoritative status-bearing fields are
   * overlaid so the project's label/id are never replaced by the provider's.
   */
  const containers = $derived.by(() => {
    const byKey: Record<string, CloudDeploymentContainer> = {}
    for (const kind of providers) {
      const cached = cloudDeployState.overviews[CloudDeployState.overviewKey(projectId, kind)]
      for (const container of cached?.value.containers ?? []) {
        byKey[`${container.providerKind}/${container.id}`] = container
      }
    }
    for (const [key, entry] of Object.entries(cloudDeployState.containerStatuses)) {
      if (!key.startsWith(`${projectId}/`)) continue
      const container = entry.value
      const existing = byKey[`${container.providerKind}/${container.id}`]
      if (!existing) continue
      byKey[`${container.providerKind}/${container.id}`] = {
        ...existing,
        status: container.status,
        updatedAt: container.updatedAt,
        createdAt: container.createdAt,
        log: container.log,
        url: container.url,
        urls: container.urls
      }
    }
    return Object.values(byKey)
  })

  /** Containers grouped by provider, then by project name. */
  const containersByProvider = $derived.by(() => {
    const groups: Record<
      string,
      Array<{ project: string; containers: CloudDeploymentContainer[] }>
    > = {}
    for (const container of filteredContainers) {
      const providerGroup = groups[container.providerKind] ?? (groups[container.providerKind] = [])
      const projectName = container.project ?? 'Other'
      let projectGroup = providerGroup.find((g) => g.project === projectName)
      if (!projectGroup) {
        projectGroup = { project: projectName, containers: [] }
        providerGroup.push(projectGroup)
      }
      projectGroup.containers.push(container)
    }
    return groups
  })

  const filteredContainers = $derived.by(() => {
    const q = searchQuery.trim().toLowerCase()
    return containers.filter((c) => {
      if (statusFilter !== 'all' && c.status !== statusFilter) return false
      if (!q) return true
      const haystack = [c.label, c.id, c.project ?? '', c.providerKind].join(' ').toLowerCase()
      return haystack.includes(q)
    })
  })

  const hasContainers = $derived(containers.length > 0)
  const hasFilteredResults = $derived(filteredContainers.length > 0)

  /** True while a configured provider's overview hasn't loaded into the cache yet. */
  const containersLoading = $derived(
    configured &&
      providers.some(
        (kind) =>
          cloudDeployState.overviews[CloudDeployState.overviewKey(projectId, kind)] === undefined
      )
  )

  /** Per-provider load errors surfaced from the overview result. */
  const accessErrors = $derived.by(() => {
    const result: Record<string, string> = {}
    for (const kind of providers) {
      const accessError =
        cloudDeployState.overviews[CloudDeployState.overviewKey(projectId, kind)]?.value
          ?.accessError
      if (accessError) result[kind] = accessError
    }
    return result
  })

  const anyAccessError = $derived(Object.keys(accessErrors).length > 0)

  function message(reason: unknown): string {
    if (!(reason instanceof Error)) return 'Cloud deployments could not be loaded.'
    return reason.message
      .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      .replace(/^Error:\s*/u, '')
  }

  async function loadConfig(): Promise<void> {
    configLoading = true
    try {
      config = await invoke('cloudDeploy:getConfig', projectId)
    } catch (reason) {
      error = message(reason)
    } finally {
      configLoading = false
    }
  }

  /** True while the home screen refresh is running (spins the icon). */
  let refreshingAll = $state(false)

  async function refreshAll(): Promise<void> {
    if (refreshingAll) return
    refreshingAll = true
    try {
      for (const kind of providers) {
        try {
          await cloudDeployState.ensureOverview(projectId, kind, true)
        } catch {
          // The store surfaces a tailored message via its error channel; the
          // panel keeps stale cached data (if any) on screen.
        }
      }
    } finally {
      refreshingAll = false
    }
  }

  /** Edit a container: open the config sheet in container mode pre-filled. */
  function editContainer(container: CloudDeploymentContainer): void {
    editingContainer = container
    openConfigSheet('container')
  }

  /** Ask for confirmation before removing a container (destructive). */
  function requestRemoveContainer(container: CloudDeploymentContainer): void {
    deleteTarget = container
  }

  /** Remove a container from the project's monitoring after confirmation. */
  async function confirmRemoveContainer(): Promise<void> {
    const container = deleteTarget
    if (!container) return
    try {
      config = await invoke(
        'cloudDeploy:removeContainer',
        projectId,
        container.providerKind,
        container.id
      )
      cloudDeployState.setContainerStatus(projectId, { ...container, status: 'unknown' })
      deleteTarget = null
      await loadConfig()
      if (configured) await refreshAll()
    } catch (reason) {
      error = message(reason)
    }
  }

  function statusTone(status: CloudDeploymentContainer['status']): StatusTone {
    if (status === 'success') return 'success'
    if (status === 'failed') return 'danger'
    if (status === 'building') return 'warning'
    return 'neutral'
  }

  function statusLabel(status: CloudDeploymentContainer['status']): string {
    return status === 'unknown' ? 'unknown' : status
  }

  /** Deduped, non-empty URLs for a container, preferring the provider's list. */
  function containerUrls(container: CloudDeploymentContainer): string[] {
    const result: string[] = []
    const push = (value: string | undefined): void => {
      if (!value) return
      const trimmed = value.trim()
      if (trimmed && !result.includes(trimmed)) result.push(trimmed)
    }
    for (const url of container.urls ?? []) push(url)
    push(container.url)
    return result
  }

  $effect(() => {
    // Re-scope the store to the active project so switching projects never
    // renders another project's cached overviews/statuses/logs.
    cloudDeployState.ensureProject(projectId)
    void loadConfig()
  })

  $effect(() => {
    if (!configured) return
    for (const kind of providers) void cloudDeployState.ensureOverview(projectId, kind)
  })

  $effect(() => {
    if (!liveUpdates) return
    const timer = setInterval(() => {
      for (const kind of providers) void cloudDeployState.ensureOverview(projectId, kind)
      void cloudDeployState.monitorContainers(projectId, containers)
    }, 60_000)
    return () => clearInterval(timer)
  })

  function openContainer(container: CloudDeploymentContainer): void {
    selectedContainer = container
  }

  /**
   * Hand the selected failing deployment to an agent for diagnosis and proposed
   * fix. v1 is strictly read-only: the thread is preloaded with the failing log
   * and provider context, and the prompt asks the agent to diagnose and propose
   * a fix — never to redeploy, trigger, or auto-fix.
   */
  async function startAgentRemediation(logText: string): Promise<void> {
    const container = selectedContainer
    if (!container) return
    const project = await invoke('project:get', projectId).catch(() => null)
    if (!project) return

    const thread = await invoke('thread:create', {
      projectId,
      providerId: 'opencode',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: project.path,
      settings: { ...threadSettings.lastUsed }
    }).catch(() => null)
    if (!thread) return

    rendererRecovery.setDraft(projectId, thread.id, remediationPrompt(container, logText), [], [])
    workspaceState.openThread(thread, project)
  }

  /** Read-only diagnosis prompt given to the agent, explicitly no auto-fix. */
  function remediationPrompt(container: CloudDeploymentContainer, log: string): string {
    const provider = PROVIDER_LABELS[container.providerKind] ?? container.providerKind
    return [
      `This project failed to deploy on ${provider}, and below is the deployment log.`,
      'Help me diagnose and fix it. When you are done, give me a summary report of what happened.',
      '',
      log.trim() || '(no deployment log text was available)'
    ].join('\n')
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if selectedContainer}
    <CloudDeploymentDetail
      {projectId}
      container={selectedContainer}
      onBack={() => (selectedContainer = null)}
      onUpdated={(updated) => cloudDeployState.setContainerStatus(projectId, updated)}
      onRemediate={(logText) => void startAgentRemediation(logText)}
    />
  {:else}
    <!-- Header -->
    <div class="flex shrink-0 flex-col gap-2 border-b border-border bg-surface/40 px-3.5 py-3">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <div
              class="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10 text-primary"
            >
              <Cloud size={14} />
            </div>
            <p class="text-sm font-semibold leading-none tracking-tight text-foreground">
              Cloud Deployments
            </p>
          </div>
          <p class="mt-1.5 line-clamp-1 text-xs leading-none text-muted">
            {#if configured}
              {containers.length} container{containers.length === 1 ? '' : 's'} · {providers.length} provider{providers.length ===
              1
                ? ''
                : 's'}
            {:else}
              Connect a provider to monitor deploys
            {/if}
          </p>
        </div>
        <div class="flex shrink-0 items-center gap-1">
          {#if configured}
            <button
              type="button"
              class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
              title="Refresh deployments"
              aria-label="Refresh deployments"
              onclick={() => void refreshAll()}
            >
              <RefreshCw size={13} class={refreshingAll ? 'animate-spin' : ''} />
            </button>
          {/if}
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary hover:bg-primary-hover"
            title={configured ? 'Add container or provider' : 'Configure cloud deployments'}
            aria-label={configured ? 'Add container or provider' : 'Configure cloud deployments'}
            onclick={() => openConfigSheet(configured ? 'container' : 'provider')}
          >
            <Plus size={13} />
            {configured ? 'Add' : 'Connect'}
          </button>
        </div>
      </div>
      {#if configured && hasContainers}
        <div class="flex items-center gap-2">
          <div class="relative flex-1">
            <Search
              size={12}
              class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
            />
            <input
              type="text"
              placeholder="Search containers…"
              class="h-7 w-full rounded-lg border border-border bg-surface py-1 pl-7 pr-2 text-xs placeholder:text-dimmed focus:border-primary/40 focus:outline-none focus:ring-1 focus:ring-primary/20"
              bind:value={searchQuery}
            />
          </div>
          {#if searchQuery}
            <button
              type="button"
              class="shrink-0 rounded-lg px-2 py-1 text-xs text-muted hover:bg-elevated hover:text-foreground"
              onclick={() => (searchQuery = '')}
              title="Clear search"
              aria-label="Clear search"
            >
              Clear
            </button>
          {/if}
        </div>
      {/if}
    </div>

    {#if configLoading}
      <div class="flex flex-1 items-center justify-center gap-2 py-10 text-sm text-muted">
        <Loader2 size={16} class="animate-spin" />
        Loading deployments…
      </div>
    {:else if !configured}
      <EmptyState
        icon={Rocket}
        title="No cloud deployments configured"
        description="Add a provider and its containers to monitor deployment status and logs for this project."
      >
        {#snippet action()}
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => openConfigSheet('provider')}
          >
            Add provider
          </button>
        {/snippet}
      </EmptyState>
    {:else if error && !hasContainers}
      <EmptyState icon={CircleX} title="Deployments unavailable" description={error} />
    {:else if containersLoading}
      <div class="flex min-h-0 flex-1 items-center justify-center gap-2 py-10 text-sm text-muted">
        <Loader2 size={16} class="animate-spin" />
        Loading containers…
      </div>
    {:else if containers.length === 0 && !anyAccessError}
      <EmptyState
        icon={Cloud}
        title="No containers added yet"
        description="Pick the containers (projects or applications) on your provider account to monitor. Status and logs appear here once added."
      >
        {#snippet action()}
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => openConfigSheet('container')}
          >
            Add container
          </button>
        {/snippet}
      </EmptyState>{:else if !hasFilteredResults}
      <div class="flex flex-col items-center justify-center gap-3 px-6 py-10 text-center">
        <div class="flex h-9 w-9 items-center justify-center rounded-full bg-surface text-muted">
          <Search size={16} />
        </div>
        <div>
          <p class="text-sm font-medium text-foreground">No matching containers</p>
          <p class="mt-1 text-xs text-muted">Try a different search or clear filters.</p>
        </div>
        <button
          type="button"
          class="rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-medium hover:bg-elevated"
          onclick={() => {
            searchQuery = ''
            statusFilter = 'all'
          }}
        >
          Clear filters
        </button>
      </div>
    {:else}
      <!-- Status filter -->
      <div class="flex items-center gap-1 border-b border-border bg-surface/50 px-3 py-2">
        {#each [['all', 'All'], ['failed', 'Failed'], ['building', 'Building'], ['success', 'Live']] as [value, label] (value)}
          <button
            type="button"
            class="rounded-full px-2.5 py-1 text-xs font-medium transition-colors {statusFilter ===
            value
              ? 'bg-foreground text-background'
              : 'bg-surface text-muted hover:bg-elevated hover:text-foreground'}"
            onclick={() => (statusFilter = value as typeof statusFilter)}
          >
            {label}
          </button>
        {/each}
        <span class="ml-auto text-xs tabular-nums text-dimmed"
          >{filteredContainers.length} shown</span
        >
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="flex items-center gap-2 border-b border-border bg-surface px-3.5 py-2">
          <Cloud size={12} class="text-muted" />
          <h3 class="text-xs font-semibold tracking-wide text-muted">Containers</h3>
          <span class="ml-auto text-xs tabular-nums text-dimmed">{filteredContainers.length}</span>
        </div>
        {#each Object.entries(containersByProvider) as [kind, projectGroups] (kind)}
          <section class="border-b border-border">
            <div class="flex items-center gap-2 bg-surface px-3.5 py-2">
              <div class="flex h-6 w-6 items-center justify-center rounded-md bg-raised">
                <CloudProviderIcon
                  providerKind={kind as CloudDeploymentProviderKind}
                  size={11}
                  class="shrink-0 text-muted"
                  title={PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}
                />
              </div>
              <span class="text-xs font-semibold text-foreground">
                {PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}
              </span>
              <span class="rounded-full bg-raised px-1.5 py-0.5 text-xs tabular-nums text-muted"
                >{projectGroups.reduce((n, g) => n + g.containers.length, 0)}</span
              >
              <button
                type="button"
                class="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-muted hover:bg-elevated hover:text-foreground"
                title="Add container to {PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}"
                aria-label="Add container to {PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}"
                onclick={() => openConfigSheet('container')}
              >
                <Plus size={12} />
              </button>
            </div>
            {#if accessErrors[kind]}
              <p
                class="border-t border-border bg-danger/5 px-3.5 py-2 text-xs leading-relaxed text-danger"
              >
                {accessErrors[kind]}
              </p>
            {/if}
            {#each projectGroups as projectGroup (projectGroup.project)}
              <div class="border-t border-border">
                <div class="flex items-center gap-1.5 bg-surface/50 px-3.5 py-1.5">
                  <Server size={10} class="shrink-0 text-dimmed" />
                  <span class="text-xs font-medium text-muted">{projectGroup.project}</span>
                  <span class="ml-auto text-xs tabular-nums text-dimmed">
                    {projectGroup.containers.length}
                  </span>
                </div>
                <div class="divide-y divide-border">
                  {#each projectGroup.containers as container (container.id)}
                    <div
                      class="group flex w-full items-center gap-1 bg-surface transition-colors hover:bg-elevated/60"
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-3.5 py-3 text-left"
                        title="View {container.label}"
                        aria-label="View {container.label}"
                        onclick={() => openContainer(container)}
                      >
                        <div
                          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg {container.status ===
                          'failed'
                            ? 'bg-danger/10 text-danger'
                            : container.status === 'success'
                              ? 'bg-success/10 text-success'
                              : container.status === 'building'
                                ? 'bg-warning/10 text-warning'
                                : 'bg-raised text-muted'}"
                        >
                          {#if container.status === 'building'}
                            <Clock3 size={14} />
                          {:else if container.status === 'success'}
                            <CircleCheck size={14} />
                          {:else if container.status === 'failed'}
                            <CircleX size={14} />
                          {:else}
                            <Cloud size={14} />
                          {/if}
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <p class="truncate text-sm font-medium leading-none text-foreground">
                              {container.label}
                            </p>
                            {#if container.status !== 'unknown'}
                              <StatusPill tone={statusTone(container.status)}>
                                {statusLabel(container.status)}
                              </StatusPill>
                            {/if}
                          </div>
                          <div class="mt-1 flex items-center gap-1.5 text-xs text-muted">
                            {#if container.project}
                              <span
                                class="shrink-0 rounded bg-raised px-1.5 py-0.5 font-mono text-[11px] text-muted"
                                title={container.project}
                              >
                                {container.project}
                              </span>
                            {/if}
                            <span class="truncate font-mono text-xs">{container.id}</span>
                            {#if container.updatedAt}
                              <span class="shrink-0 text-dimmed"
                                >· {relativeTime(container.updatedAt)}</span
                              >
                            {/if}
                          </div>
                        </div>
                      </button>
                      <div
                        class="flex shrink-0 items-center gap-0.5 pr-2 opacity-60 transition-opacity group-hover:opacity-100"
                      >
                        {#if containerUrls(container).length > 0}
                          <ContainerLinksMenu
                            urls={containerUrls(container)}
                            title="Open {container.label} deployed sites"
                            size={13}
                          />
                        {/if}
                        <button
                          type="button"
                          class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-surface hover:text-foreground"
                          title="Edit {container.label}"
                          aria-label="Edit {container.label}"
                          onclick={() => editContainer(container)}
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                          title="Remove {container.label}"
                          aria-label="Remove {container.label}"
                          onclick={() => requestRemoveContainer(container)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </section>
        {/each}
      </div>
    {/if}

    <div
      class="flex shrink-0 items-center justify-between border-t border-border bg-surface/30 px-3.5 py-2.5"
    >
      <div>
        <p class="text-xs font-medium text-foreground">Live updates</p>
        <p class="text-xs text-muted">{liveUpdates ? 'Auto-refresh every minute' : 'Paused'}</p>
      </div>
      <Switch
        checked={liveUpdates}
        onchange={(checked) => (liveUpdates = checked)}
        aria-label="Toggle live status updates"
        title="Toggle live status updates"
      />
    </div>
  {/if}
</div>

<CloudDeploymentConfigSheet
  open={configSheetOpen}
  {projectId}
  initialMode={configSheetMode}
  {editingContainer}
  onClose={() => {
    configSheetOpen = false
    editingContainer = null
  }}
  onSaved={() => void handleConfigSaved()}
/>

{#if deleteTarget}
  <Modal open title="Remove container" onClose={() => (deleteTarget = null)}>
    <p class="text-sm text-muted">
      Remove <span class="font-medium text-foreground">{deleteTarget.label}</span> from this
      project's monitoring? The container itself is untouched on {PROVIDER_LABELS[
        deleteTarget.providerKind
      ]}; it is only no longer tracked here.
    </p>
    {#snippet footer()}
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="flex h-9 items-center justify-center rounded-lg border bg-elevated px-4 text-xs font-medium hover:bg-overlay"
          onclick={() => (deleteTarget = null)}
        >
          Cancel
        </button>
        <button
          type="button"
          class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-danger px-4 text-xs font-medium text-on-danger hover:bg-danger-hover"
          onclick={() => void confirmRemoveContainer()}
        >
          <Trash2 size={13} />
          Remove
        </button>
      </div>
    {/snippet}
  </Modal>
{/if}
