<script lang="ts">
  import {
    CircleCheck,
    CircleX,
    Clock3,
    Cloud,
    ExternalLink,
    Loader2,
    Plus,
    RefreshCw,
    Rocket,
    Server
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import { cloudDeployState, CloudDeployState } from '$lib/stores/cloud-deploy.svelte'
  import EmptyState from '../ui/EmptyState.svelte'
  import SideSheet from '../ui/SideSheet.svelte'
  import StatusPill, { type StatusTone } from '../ui/StatusPill.svelte'
  import Switch from '../ui/Switch.svelte'
  import CloudDeploymentDetail from './CloudDeploymentDetail.svelte'
  import {
    CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS,
    CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES,
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

  // Add-provider sheet state.
  let showConfigSheet = $state(false)
  let selectedKind = $state<CloudDeploymentProviderKind>('coolify')
  let baseUrl = $state('')
  let token = $state('')
  let savingProvider = $state(false)
  let configError = $state('')

  const providers = $derived(config?.project.providers ?? [])

  const configured = $derived(providers.length > 0)

  /** All configured containers, flattened across providers and deduped by key. */
  const containers = $derived.by(() => {
    const byKey: Record<string, CloudDeploymentContainer> = {}
    for (const kind of providers) {
      const cached = cloudDeployState.overviews[CloudDeployState.overviewKey(kind)]
      for (const container of cached?.value.containers ?? []) {
        byKey[`${container.providerKind}/${container.id}`] = container
      }
    }
    return Object.values(byKey)
  })

  const hasContainers = $derived(containers.length > 0)

  /** Per-provider load errors surfaced from the overview result. */
  const accessErrors = $derived.by(() => {
    const result: Record<string, string> = {}
    for (const kind of providers) {
      const accessError =
        cloudDeployState.overviews[CloudDeployState.overviewKey(kind)]?.value?.accessError
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
    }, 60_000)
    return () => clearInterval(timer)
  })

  function pickKind(kind: CloudDeploymentProviderKind): void {
    selectedKind = kind
    configError = ''
    if (CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS.includes(kind)) {
      void cloudDeployState.ensureOverview(projectId, kind)
    }
  }

  async function saveProvider(): Promise<void> {
    if (selectedKind === 'coolify' && (!token.trim() || !baseUrl.trim())) {
      configError = 'A base URL and token are required to connect Coolify.'
      return
    }
    savingProvider = true
    configError = ''
    try {
      await invoke(
        'cloudDeploy:setCredential',
        projectId,
        selectedKind,
        token.trim(),
        baseUrl.trim() || undefined
      )
      showConfigSheet = false
      baseUrl = ''
      token = ''
      await loadConfig()
      if (configured) await refreshAll()
    } catch (reason) {
      configError = message(reason)
    } finally {
      savingProvider = false
    }
  }

  function openContainer(container: CloudDeploymentContainer): void {
    selectedContainer = container
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  {#if selectedContainer}
    <CloudDeploymentDetail
      {projectId}
      container={selectedContainer}
      onBack={() => (selectedContainer = null)}
      onUpdated={(updated) => cloudDeployState.setContainerStatus(updated)}
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
        title="Configure providers"
        aria-label="Configure providers"
        onclick={() => {
          selectedKind = 'coolify'
          baseUrl = ''
          token = ''
          configError = ''
          showConfigSheet = true
        }}
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
            onclick={() => (showConfigSheet = true)}
          >
            Add provider
          </button>
        {/snippet}
      </EmptyState>
    {:else if error && !hasContainers}
      <EmptyState icon={CircleX} title="Deployments unavailable" description={error} />
    {:else if containers.length === 0 && !anyAccessError}
      <EmptyState
        icon={Cloud}
        title="No containers found"
        description="Configured providers returned no containers yet. Status appears here once available."
      />
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5">
          <Cloud size={11} class="text-dimmed" />
          <h3 class="text-[10px] font-semibold uppercase tracking-wide text-muted">Containers</h3>
          <span class="ml-auto text-[9px] tabular-nums text-dimmed">{containers.length}</span>
        </div>
        {#each providers as kind (kind)}
          {@const kindContainers = containers.filter((c) => c.providerKind === kind)}
          <section class="border-b border-border">
            <div class="flex items-center gap-1.5 bg-surface px-3 py-1.5">
              <Server size={10} class="shrink-0 text-dimmed" />
              <span class="text-[10px] font-medium text-muted">{PROVIDER_LABELS[kind]}</span>
              {#if kindContainers.length > 0}
                <span class="text-[9px] tabular-nums text-dimmed">{kindContainers.length}</span>
              {/if}
            </div>
            {#if accessErrors[kind]}
              <p
                class="border-t border-border bg-danger/10 px-3 py-1.5 text-[9px] leading-relaxed text-danger"
              >
                {accessErrors[kind]}
              </p>
            {/if}
            {#if kindContainers.length === 0}
              <p class="px-3 py-4 text-center text-[10px] text-dimmed">No containers.</p>
            {:else}
              <div class="divide-y divide-border">
                {#each kindContainers as container (container.id)}
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
                          <p class="truncate text-[11px] font-medium text-foreground">
                            {container.label}
                          </p>
                          <StatusPill tone={statusTone(container.status)}>
                            {statusLabel(container.status)}
                          </StatusPill>
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
                        class="mr-2 shrink-0 rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                        title="Open deployed site"
                        aria-label="Open deployed site"
                        onclick={() => void openInBrowser(container.url ?? '')}
                      >
                        <ExternalLink size={11} />
                      </button>
                    {/if}
                  </div>
                {/each}
              </div>
            {/if}
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

<SideSheet open={showConfigSheet} title="Add provider" onClose={() => (showConfigSheet = false)}>
  {#snippet footer()}
    <button
      type="button"
      class="h-8 rounded-lg border border-border px-3 text-[11px] font-medium text-foreground hover:bg-elevated"
      onclick={() => (showConfigSheet = false)}
    >
      Cancel
    </button>
    <button
      type="button"
      class="h-8 cursor-pointer rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
      disabled={savingProvider}
      onclick={() => void saveProvider()}
    >
      {savingProvider ? 'Saving…' : 'Save provider'}
    </button>
  {/snippet}

  <div class="space-y-4">
    <div>
      <label class="mb-1 block text-[10px] font-medium text-muted" for="cloud-provider-kind">
        Provider
      </label>
      <select
        id="cloud-provider-kind"
        class="h-8 w-full cursor-pointer rounded-lg border border-border bg-elevated px-2 text-[11px] text-foreground outline-none focus:border-primary"
        value={selectedKind}
        onchange={(event) => pickKind(event.currentTarget.value as CloudDeploymentProviderKind)}
      >
        {#each CLOUD_DEPLOYMENT_PROVIDER_KIND_VALUES as kind (kind)}
          <option value={kind}>{PROVIDER_LABELS[kind]}</option>
        {/each}
      </select>
      {#if CLOUD_DEPLOYMENT_NOT_IMPLEMENTED_KINDS.includes(selectedKind)}
        <p class="mt-1 text-[9px] text-dimmed">
          This provider isn't supported yet — selecting it shows a notice and makes no network call.
        </p>
      {/if}
    </div>

    {#if selectedKind === 'coolify'}
      <div>
        <label class="mb-1 block text-[10px] font-medium text-muted" for="cloud-base-url">
          Base URL
        </label>
        <input
          id="cloud-base-url"
          type="url"
          class="h-8 w-full rounded-lg border border-border bg-elevated px-2 text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="https://your-coolify-instance.example"
          value={baseUrl}
          oninput={(event) => (baseUrl = event.currentTarget.value)}
        />
        <p class="mt-1 text-[9px] text-dimmed">
          A verified, explicit URL. Localhost is allowed only for local development.
        </p>
      </div>
      <div>
        <label class="mb-1 block text-[10px] font-medium text-muted" for="cloud-token">
          API token
        </label>
        <input
          id="cloud-token"
          type="password"
          class="h-8 w-full rounded-lg border border-border bg-elevated px-2 text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Coolify API token"
          value={token}
          oninput={(event) => (token = event.currentTarget.value)}
        />
      </div>
    {/if}

    {#if configError}
      <p class="rounded-md bg-danger/10 px-2 py-1.5 text-[10px] text-danger">{configError}</p>
    {/if}
  </div>
</SideSheet>
