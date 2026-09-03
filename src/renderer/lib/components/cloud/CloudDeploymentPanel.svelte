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
  import { pathToFileUrl } from '$lib/mime'
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
    type CloudDeploymentProviderKind,
    type PromptAttachment
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

  /** Log tail kept inline in the diagnosis prompt; the full log rides along as a pasted-text attachment. */
  const INLINE_LOG_EXCERPT_CHARS = 24_000

  /** When set, the in-app detail view replaces the container list. */
  let selectedContainer = $state<CloudDeploymentContainer | null>(null)

  let config = $state<CloudDeploymentConfig | null>(null)
  let configLoading = $state(true)
  let error = $state('')

  /** Auto-revalidate statuses while mounted. */
  let liveUpdates = $state(true)

  /** Text search is collapsed by default; the status strip below is always visible. */
  let searchOpen = $state(false)
  let searchQuery = $state('')
  type StatusFilter = 'all' | CloudDeploymentContainer['status']
  let statusFilter = $state<StatusFilter>('all')
  let providerFilter = $state<'all' | CloudDeploymentProviderKind>('all')

  function clearFilters(): void {
    searchQuery = ''
    statusFilter = 'all'
    providerFilter = 'all'
  }

  /** Collapsing search also drops the query, so nothing stays filtered invisibly. */
  function toggleSearch(): void {
    searchOpen = !searchOpen
    if (!searchOpen) searchQuery = ''
  }

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
      if (providerFilter !== 'all' && c.providerKind !== providerFilter) return false
      if (!q) return true
      const haystack = [c.label, c.id, c.project ?? '', c.providerKind].join(' ').toLowerCase()
      return haystack.includes(q)
    })
  })

  const hasContainers = $derived(containers.length > 0)
  const hasFilteredResults = $derived(filteredContainers.length > 0)

  /**
   * The status strip doubles as the panel's dashboard and its filter, so counts
   * come from every container regardless of the active filter. Empty buckets are
   * dropped so the strip stays one line in a narrow sidebar.
   */
  const statusChips = $derived.by(() => {
    const buckets: Array<{ value: StatusFilter; label: string; tone: StatusTone }> = [
      { value: 'failed', label: 'Failed', tone: 'danger' },
      { value: 'building', label: 'Building', tone: 'warning' },
      { value: 'success', label: 'Live', tone: 'success' },
      { value: 'unknown', label: 'Unknown', tone: 'neutral' }
    ]
    const chips = [
      {
        value: 'all' as StatusFilter,
        label: 'All',
        tone: 'neutral' as StatusTone,
        count: containers.length
      }
    ]
    for (const bucket of buckets) {
      const count = containers.filter((c) => c.status === bucket.value).length
      if (count > 0) chips.push({ ...bucket, count })
    }
    return chips
  })

  /** Provider chips share the filter strip and carry their own add-container action. */
  const providerChips = $derived(
    providers.map((kind) => ({
      kind,
      label: PROVIDER_LABELS[kind] ?? kind,
      count: containers.filter((c) => c.providerKind === kind).length
    }))
  )

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

  /** Row pills and the status strip share one vocabulary. */
  function statusLabel(status: CloudDeploymentContainer['status']): string {
    if (status === 'success') return 'Live'
    if (status === 'failed') return 'Failed'
    if (status === 'building') return 'Building'
    return 'Unknown'
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
      providerId: 'pi',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: project.path,
      settings: { ...threadSettings.lastUsed }
    }).catch(() => null)
    if (!thread) return

    const [prompt, attachments] = await remediationPrompt(container, logText, thread.id)
    rendererRecovery.setDraft(projectId, thread.id, prompt, attachments, [])
    workspaceState.openThread(thread, project)
  }

  /**
   * Read-only diagnosis prompt given to the agent, explicitly no auto-fix.
   *
   * The full log is attached as a pasted-text file instead of being inlined:
   * deployment logs can far exceed the 200k prompt limit, and an oversized
   * inlined log makes `agent:sendPrompt` throw. A short tail excerpt stays
   * inline so the thread opens with immediate context.
   */
  async function remediationPrompt(
    container: CloudDeploymentContainer,
    log: string,
    threadId: string
  ): Promise<[string, PromptAttachment[]]> {
    const provider = PROVIDER_LABELS[container.providerKind] ?? container.providerKind
    const trimmed = log.trim()
    const attachments: PromptAttachment[] = []
    if (trimmed) {
      const path = await invoke(
        'attachment:saveText',
        { kind: 'chat', projectId, threadId },
        trimmed
      )
      attachments.push({
        mime: 'text/plain',
        url: pathToFileUrl(path),
        filename: 'Pasted text.txt'
      })
    }
    const fence = '```'
    const inlineExcerpt = trimmed
      ? `Recent log tail (the full log is attached as "Pasted text.txt"):

${fence}text
${trimmed.slice(-INLINE_LOG_EXCERPT_CHARS)}${trimmed.length > INLINE_LOG_EXCERPT_CHARS ? '\n[earlier output omitted]' : ''}
${fence}`
      : '(no deployment log text was available)'
    const prompt = [
      `This project failed to deploy on ${provider}.`,
      'Help me diagnose and fix it. When you are done, give me a summary report of what happened.',
      '',
      inlineExcerpt
    ].join('\n')
    return [prompt, attachments]
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
    {#if configured && hasContainers}
      <!-- Filter strip: status counts and providers in one row; also the panel's dashboard. -->
      <div
        class="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-2 py-1"
      >
        {#each statusChips as chip (chip.value)}
          <button
            type="button"
            class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.625rem] font-medium transition-colors {statusFilter ===
            chip.value
              ? 'bg-raised text-foreground'
              : 'text-muted hover:bg-elevated hover:text-foreground'}"
            title="Show {chip.label.toLowerCase()} containers"
            aria-label="Show {chip.label.toLowerCase()} containers"
            aria-pressed={statusFilter === chip.value}
            onclick={() => (statusFilter = chip.value)}
          >
            {#if chip.value !== 'all'}
              <span
                class="h-1.5 w-1.5 shrink-0 rounded-full {chip.tone === 'danger'
                  ? 'bg-danger'
                  : chip.tone === 'warning'
                    ? 'bg-warning'
                    : chip.tone === 'success'
                      ? 'bg-success'
                      : 'bg-dimmed'}"
                aria-hidden="true"
              ></span>
            {/if}
            {chip.label}
            <span class="tabular-nums text-dimmed">{chip.count}</span>
          </button>
        {/each}

        {#if providerChips.length > 0}
          <span class="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
        {/if}

        {#each providerChips as chip (chip.kind)}
          <!-- Chip and its add action are siblings so neither button nests in the other. -->
          <div
            class="flex h-6 shrink-0 items-center rounded-md transition-colors {providerFilter ===
            chip.kind
              ? 'bg-raised text-foreground'
              : 'text-muted hover:bg-elevated'}"
          >
            <button
              type="button"
              class="flex h-6 cursor-pointer items-center gap-1 rounded-l-md pl-1.5 pr-1 text-[0.625rem] font-medium hover:text-foreground"
              title="Show only {chip.label} containers"
              aria-label="Show only {chip.label} containers"
              aria-pressed={providerFilter === chip.kind}
              onclick={() => (providerFilter = providerFilter === chip.kind ? 'all' : chip.kind)}
            >
              <CloudProviderIcon
                providerKind={chip.kind}
                size={10}
                class="shrink-0"
                title={chip.label}
              />
              {chip.label}
              <span class="tabular-nums text-dimmed">{chip.count}</span>
            </button>
            <button
              type="button"
              class="flex h-6 w-5 cursor-pointer items-center justify-center rounded-r-md text-dimmed hover:text-foreground"
              title="Add a {chip.label} container to monitor"
              aria-label="Add a {chip.label} container to monitor"
              onclick={() => openConfigSheet('container')}
            >
              <Plus size={11} />
            </button>
          </div>
        {/each}
      </div>
    {/if}

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
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
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
            class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => openConfigSheet('container')}
          >
            Add container
          </button>
        {/snippet}
      </EmptyState>{:else if !hasFilteredResults}
      <div class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <Search size={16} class="text-dimmed" />
        <p class="text-[0.6875rem] font-medium text-foreground">No matching containers</p>
        <button
          type="button"
          class="h-7 cursor-pointer rounded-md border border-border px-2.5 text-[0.625rem] font-medium text-foreground hover:bg-elevated"
          onclick={clearFilters}
        >
          Clear filters
        </button>
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        {#each Object.entries(containersByProvider) as [kind, projectGroups] (kind)}
          <section class="border-b border-border">
            <div class="flex items-center gap-1.5 bg-surface px-3 py-1.5">
              <CloudProviderIcon
                providerKind={kind as CloudDeploymentProviderKind}
                size={10}
                class="shrink-0 text-dimmed"
                title={PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}
              />
              <h3 class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
                {PROVIDER_LABELS[kind as CloudDeploymentProviderKind]}
              </h3>
              <span class="ml-auto text-[0.5625rem] tabular-nums text-dimmed"
                >{projectGroups.reduce((n, g) => n + g.containers.length, 0)}</span
              >
            </div>
            {#if accessErrors[kind]}
              <p
                class="border-t border-border bg-danger/10 px-3 py-1.5 text-[0.5625rem] leading-relaxed text-danger"
              >
                {accessErrors[kind]}
              </p>
            {/if}
            {#each projectGroups as projectGroup (projectGroup.project)}
              <div class="border-t border-border">
                <div class="flex items-center gap-1.5 bg-surface/50 px-3 py-1">
                  <Server size={9} class="shrink-0 text-dimmed" />
                  <span class="truncate text-[0.5625rem] font-medium text-muted">
                    {projectGroup.project}
                  </span>
                  <span class="ml-auto text-[0.5625rem] tabular-nums text-dimmed">
                    {projectGroup.containers.length}
                  </span>
                </div>
                <div class="divide-y divide-border">
                  {#each projectGroup.containers as container (container.id)}
                    <div
                      class="group flex w-full items-center gap-1 transition-colors hover:bg-elevated"
                    >
                      <button
                        type="button"
                        class="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-3 py-2 text-left"
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
                          <div class="flex items-center gap-1.5">
                            <p class="truncate text-[0.6875rem] font-medium text-foreground">
                              {container.label}
                            </p>
                            <StatusPill
                              tone={statusTone(container.status)}
                              dot
                              title="Deployment status: {statusLabel(container.status)}"
                            >
                              {statusLabel(container.status)}
                            </StatusPill>
                          </div>
                          <div class="mt-0.5 flex items-center gap-1.5 text-[0.5625rem] text-dimmed">
                            <span class="truncate font-mono">{container.id}</span>
                            {#if container.updatedAt}
                              <span class="shrink-0">· {relativeTime(container.updatedAt)}</span>
                            {/if}
                          </div>
                        </div>
                      </button>
                      <div
                        class="flex shrink-0 items-center pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100"
                      >
                        {#if containerUrls(container).length > 0}
                          <ContainerLinksMenu
                            urls={containerUrls(container)}
                            title="Open {container.label} deployed sites"
                            size={11}
                          />
                        {/if}
                        <button
                          type="button"
                          class="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-raised hover:text-foreground"
                          title="Edit {container.label}"
                          aria-label="Edit {container.label}"
                          onclick={() => editContainer(container)}
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          type="button"
                          class="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
                          title="Remove {container.label}"
                          aria-label="Remove {container.label}"
                          onclick={() => requestRemoveContainer(container)}
                        >
                          <Trash2 size={11} />
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

    {#if configured && hasContainers && searchOpen}
      <div class="relative shrink-0 border-t border-border bg-surface px-2 py-1.5">
        <Search
          size={11}
          class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          autofocus
          placeholder="Search by name, id or project…"
          aria-label="Search containers"
          class="h-6 w-full rounded-md border border-border bg-elevated pl-6 pr-2 text-[0.625rem] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          bind:value={searchQuery}
        />
      </div>
    {/if}

    <!-- Status bar: inventory on the left, the panel's actions on the right. -->
    <div class="flex h-9 shrink-0 items-center gap-1 border-t border-border px-2">
      <span class="truncate text-[0.6875rem] text-muted">
        {#if configured}
          {containers.length} container{containers.length === 1 ? '' : 's'} · {providers.length} provider{providers.length ===
          1
            ? ''
            : 's'}
        {:else}
          No providers configured
        {/if}
      </span>
      <button
        type="button"
        class="flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title={configured ? 'Add a container to monitor' : 'Connect a cloud provider'}
        aria-label={configured ? 'Add a container to monitor' : 'Connect a cloud provider'}
        onclick={() => openConfigSheet(configured ? 'container' : 'provider')}
      >
        <Plus size={13} />
        {configured ? 'Add' : 'Connect'}
      </button>

      <div class="ml-auto flex shrink-0 items-center gap-0.5">
        {#if configured && hasContainers}
          <button
            type="button"
            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-elevated hover:text-foreground {searchOpen
              ? 'bg-elevated text-foreground'
              : 'text-muted'}"
            title="Search containers by name, id or project"
            aria-label="Search containers by name, id or project"
            aria-pressed={searchOpen}
            onclick={toggleSearch}
          >
            <Search size={13} />
          </button>
        {/if}
        {#if configured}
          <button
            type="button"
            class="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Refresh deployment statuses now"
            aria-label="Refresh deployment statuses now"
            onclick={() => void refreshAll()}
          >
            <RefreshCw size={13} class={refreshingAll ? 'animate-spin' : ''} />
          </button>
        {/if}
        <Switch
          checked={liveUpdates}
          onchange={(checked) => (liveUpdates = checked)}
          class="ml-1 h-7"
          aria-label="Toggle live status updates"
          title={liveUpdates
            ? 'Live updates on — refreshing every minute'
            : 'Live updates paused — refresh manually'}
        />
      </div>
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
