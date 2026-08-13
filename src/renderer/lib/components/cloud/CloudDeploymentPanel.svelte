<script lang="ts">
  import {
    CircleCheck,
    CircleX,
    Clock3,
    Cloud,
    ExternalLink,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Rocket,
    Server,
    Trash2
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import { cloudDeployState, CloudDeployState } from '$lib/stores/cloud-deploy.svelte'
  import { cloudAccountsState } from '$lib/stores/cloud-accounts.svelte'
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
        url: container.url
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
    for (const container of containers) {
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

  const hasContainers = $derived(containers.length > 0)

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

  async function refreshAll(): Promise<void> {
    for (const kind of providers) {
      try {
        await cloudDeployState.ensureOverview(projectId, kind, true)
      } catch {
        // The store surfaces a tailored message via its error channel; the
        // panel keeps stale cached data (if any) on screen.
      }
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

  /** The exact failing log for the selected container, from the store cache. */
  function selectedFailingLog(): string {
    const container = selectedContainer
    if (!container) return ''
    const cached =
      cloudDeployState.containerLogs[
        CloudDeployState.containerKey(projectId, container.providerKind, container.id)
      ]
    return cached?.value.log ?? container.log ?? ''
  }

  /** The provider context (label, id, provider, base URL) for the selected container. */
  function selectedProviderContext(): string {
    const container = selectedContainer
    if (!container) return ''
    const providerAccounts = config?.project.providerAccounts?.[container.providerKind]
    const activeAccountId = providerAccounts?.activeAccountId ?? null
    const activeAccount = activeAccountId
      ? cloudAccountsState.accountById(activeAccountId)
      : undefined
    return [
      `Container: ${container.label}`,
      `Container ID: ${container.id}`,
      `Provider: ${PROVIDER_LABELS[container.providerKind]} (${container.providerKind})`,
      ...(activeAccount?.baseUrl ? [`Base URL: ${activeAccount.baseUrl}`] : []),
      ...(container.url ? [`Deployed URL: ${container.url}`] : [])
    ].join('\n')
  }

  /**
   * Hand the selected failing deployment to an agent for diagnosis and proposed
   * fix. v1 is strictly read-only: the thread is preloaded with the failing log
   * and provider context, and the prompt asks the agent to diagnose and propose
   * a fix — never to redeploy, trigger, or auto-fix.
   */
  async function startAgentRemediation(): Promise<void> {
    const container = selectedContainer
    if (!container) return
    const project = await invoke('project:get', projectId).catch(() => null)
    if (!project) return

    const log = selectedFailingLog()
    const thread = await invoke('thread:create', {
      projectId,
      providerId: 'opencode',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: project.path,
      settings: { ...threadSettings.lastUsed }
    }).catch(() => null)
    if (!thread) return

    rendererRecovery.setDraft(
      projectId,
      thread.id,
      remediationPrompt(container, log, selectedProviderContext()),
      [],
      []
    )
    workspaceState.openThread(thread, project)
  }

  /** Read-only diagnosis prompt given to the agent, explicitly no auto-fix. */
  function remediationPrompt(
    container: CloudDeploymentContainer,
    log: string,
    providerContext: string
  ): string {
    return [
      `Diagnose the failed deployment of "${container.label}" and propose a fix.`,
      '',
      'PROVIDER CONTEXT',
      providerContext,
      '',
      'FAILING DEPLOYMENT LOG',
      log || '(no log text was available)',
      '',
      'Analyze why this deployment failed and propose a concrete fix. Diagnose only:',
      'do not redeploy, trigger, or modify anything — report your diagnosis and proposed',
      'fix for review.'
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
      onRemediate={() => void startAgentRemediation()}
    />
  {:else}
    <!-- Header -->
    <div class="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
      <div class="min-w-0 flex-1">
        <p class="text-[11px] font-semibold text-foreground">Cloud Deployments</p>
        <p class="truncate text-[9px] text-dimmed">
          {#if configured}
            {providers.length} provider{providers.length === 1 ? '' : 's'} configured
          {:else}
            No providers configured
          {/if}
        </p>
      </div>
      {#if configured}
        <button
          type="button"
          class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          title="Refresh deployments"
          aria-label="Refresh deployments"
          onclick={() => void refreshAll()}
        >
          <RefreshCw size={12} />
        </button>
      {/if}
      <button
        type="button"
        class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Configure cloud deployments"
        aria-label="Configure cloud deployments"
        onclick={() => openConfigSheet('provider')}
      >
        <Plus size={14} />
      </button>
    </div>

    {#if configLoading}
      <div class="flex flex-1 items-center justify-center gap-2 text-[11px] text-dimmed">
        <Loader2 size={13} class="animate-spin" />
        Loading deployments
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
      <div class="flex min-h-0 flex-1 items-center justify-center gap-2 text-[11px] text-dimmed">
        <Loader2 size={13} class="animate-spin" />
        Loading containers
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
      </EmptyState>{:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
          <Cloud size={11} class="text-dimmed" />
          <h3 class="text-[10px] font-semibold uppercase tracking-wide text-muted">Containers</h3>
          <span class="ml-auto text-[9px] tabular-nums text-dimmed">{containers.length}</span>
          <button
            type="button"
            class="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Add container"
            aria-label="Add container"
            onclick={() => openConfigSheet('container')}
          >
            <Plus size={11} />
          </button>
        </div>
        {#each Object.entries(containersByProvider) as [kind, projectGroups] (kind)}
          <section class="border-b border-border">
            <div class="flex items-center gap-1.5 bg-surface px-3 py-1.5">
              <CloudProviderIcon
                providerKind={kind as CloudDeploymentProviderKind}
                size={10}
                class="shrink-0 text-dimmed"
                title={PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}
              />
              <span class="text-[10px] font-medium text-muted">
                {PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}
              </span>
              <span class="text-[9px] tabular-nums text-dimmed"
                >{projectGroups.reduce((n, g) => n + g.containers.length, 0)}</span
              >
            </div>
            {#if accessErrors[kind]}
              <p
                class="border-t border-border bg-danger/10 px-3 py-1.5 text-[9px] leading-relaxed text-danger"
              >
                {accessErrors[kind]}
              </p>
            {/if}
            {#each projectGroups as projectGroup (projectGroup.project)}
              <div class="border-t border-border">
                <div class="flex items-center gap-1.5 bg-surface/50 px-3 py-1">
                  <Server size={9} class="shrink-0 text-dimmed" />
                  <span class="text-[9px] font-medium text-muted">{projectGroup.project}</span>
                  <span class="ml-auto text-[9px] tabular-nums text-dimmed">
                    {projectGroup.containers.length}
                  </span>
                </div>
                <div class="divide-y divide-border">
                  {#each projectGroup.containers as container (container.id)}
                    <div class="flex w-full items-center gap-1 transition-colors hover:bg-elevated">
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 cursor-pointer items-start gap-2.5 px-3 py-2 text-left"
                        title="View {container.label}"
                        aria-label="View {container.label}"
                        onclick={() => openContainer(container)}
                      >
                        {#if container.status === 'building'}
                          <Clock3 size={13} class="mt-0.5 shrink-0 text-warning" />
                        {:else if container.status === 'success'}
                          <CircleCheck size={13} class="mt-0.5 shrink-0 text-success" />
                        {:else if container.status === 'failed'}
                          <CircleX size={13} class="mt-0.5 shrink-0 text-danger" />
                        {:else}
                          <Cloud size={13} class="mt-0.5 shrink-0 text-dimmed" />
                        {/if}
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            {#if container.project}
                              <span
                                class="shrink-0 rounded bg-raised px-1 py-0.5 font-mono text-[9px] text-muted"
                                title={container.project}
                              >
                                {container.project}
                              </span>
                            {/if}
                            <p class="truncate text-[11px] font-medium text-foreground">
                              {container.label}
                            </p>
                            {#if container.status !== 'unknown'}
                              <StatusPill tone={statusTone(container.status)}>
                                {statusLabel(container.status)}
                              </StatusPill>
                            {/if}
                          </div>
                          <div class="mt-0.5 flex items-center gap-1.5 text-[9px] text-dimmed">
                            <span class="font-mono">{container.id}</span>
                            {#if container.updatedAt}
                              <span>·</span>
                              <span class="shrink-0">{relativeTime(container.updatedAt)}</span>
                            {/if}
                          </div>
                        </div>
                      </button>
                      {#if container.url}
                        <button
                          type="button"
                          class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                          title="Open deployed site"
                          aria-label="Open deployed site"
                          onclick={() => void openInBrowser(container.url ?? '')}
                        >
                          <ExternalLink size={11} />
                        </button>
                      {/if}
                      <button
                        type="button"
                        class="shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                        title="Edit {container.label}"
                        aria-label="Edit {container.label}"
                        onclick={() => editContainer(container)}
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        type="button"
                        class="mr-1 shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
                        title="Remove {container.label}"
                        aria-label="Remove {container.label}"
                        onclick={() => requestRemoveContainer(container)}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  {/each}
                </div>
              </div>
            {/each}
          </section>
        {/each}
      </div>
    {/if}

    <div class="flex shrink-0 items-center justify-between border-t border-border px-3 py-2">
      <span class="text-[9px] text-dimmed">Live updates</span>
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
