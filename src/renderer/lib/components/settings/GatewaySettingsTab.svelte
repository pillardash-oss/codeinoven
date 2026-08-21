<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    Copy,
    ExternalLink,
    Loader2,
    Play,
    RefreshCw,
    Square,
    Trash2,
    Upload
  } from '@lucide/svelte'
  import type { GatewayStatus } from '$shared/gateway-types'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { toast } from 'svelte-sonner'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'

  let gateways = $state<GatewayStatus[]>([])
  let loading = $state(true)
  let busyPluginId = $state<string | null>(null)
  let error = $state('')
  let actionNotice = $state('')
  let uninstallTarget = $state<GatewayStatus | null>(null)
  let updateTarget = $state<GatewayStatus | null>(null)

  const lifecycleLabels: Record<GatewayStatus['lifecycle'], string> = {
    not_installed: 'Not installed',
    installing: 'Installing',
    stopped: 'Stopped',
    starting: 'Starting',
    ready: 'Running',
    stopping: 'Stopping',
    error: 'Error'
  }

  function lifecycleClass(lifecycle: GatewayStatus['lifecycle']): string {
    if (lifecycle === 'ready') return 'bg-success/10 text-success'
    if (lifecycle === 'error') return 'bg-danger/10 text-danger'
    if (lifecycle === 'starting' || lifecycle === 'stopping' || lifecycle === 'installing')
      return 'bg-warning/10 text-warning'
    return 'bg-elevated text-muted'
  }

  async function loadGateways(): Promise<void> {
    loading = true
    error = ''
    try {
      gateways = await invoke('gateway:list')
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Gateways could not be inspected.'
    } finally {
      loading = false
    }
  }

  async function setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    busyPluginId = pluginId
    error = ''
    try {
      const status = await invoke('gateway:setEnabled', pluginId, enabled)
      applyStatus(status)
      if (!enabled) actionNotice = 'Gateway disabled'
    } catch (toggleError) {
      error = toggleError instanceof Error ? toggleError.message : 'The gateway could not be updated.'
    } finally {
      busyPluginId = null
    }
  }

  async function startGateway(pluginId: string): Promise<void> {
    busyPluginId = pluginId
    error = ''
    actionNotice = ''
    try {
      applyStatus(await invoke('gateway:start', pluginId))
    } catch (startError) {
      error = startError instanceof Error ? startError.message : 'The gateway could not be started.'
    } finally {
      busyPluginId = null
    }
  }

  async function stopGateway(pluginId: string): Promise<void> {
    busyPluginId = pluginId
    error = ''
    try {
      applyStatus(await invoke('gateway:stop', pluginId))
    } catch (stopError) {
      error = stopError instanceof Error ? stopError.message : 'The gateway could not be stopped.'
    } finally {
      busyPluginId = null
    }
  }

  async function refreshCatalog(pluginId: string): Promise<void> {
    busyPluginId = pluginId
    error = ''
    try {
      const models = await invoke('gateway:refreshCatalog', pluginId)
      actionNotice = `Discovered ${models.length} model${models.length === 1 ? '' : 's'}`
      await loadGateways()
    } catch (refreshError) {
      error =
        refreshError instanceof Error ? refreshError.message : 'The model catalog could not be refreshed.'
    } finally {
      busyPluginId = null
    }
  }

  async function uninstallGateway(pluginId: string): Promise<void> {
    uninstallTarget = null
    busyPluginId = pluginId
    error = ''
    try {
      applyStatus(await invoke('gateway:uninstall', pluginId))
      toast.success('Gateway uninstalled')
    } catch (uninstallError) {
      error =
        uninstallError instanceof Error ? uninstallError.message : 'The gateway could not be uninstalled.'
    } finally {
      busyPluginId = null
    }
  }

  async function updateGateway(pluginId: string): Promise<void> {
    updateTarget = null
    busyPluginId = pluginId
    error = ''
    try {
      applyStatus(await invoke('gateway:update', pluginId))
      toast.success('Gateway updated')
    } catch (updateError) {
      error = updateError instanceof Error ? updateError.message : 'The gateway could not be updated.'
    } finally {
      busyPluginId = null
    }
  }

  async function copyDashboardPassword(pluginId: string): Promise<void> {
    try {
      await invoke('gateway:copyDashboardPassword', pluginId)
      toast.success('Dashboard password copied to the clipboard')
    } catch (copyError) {
      toast.error(
        copyError instanceof Error ? copyError.message : 'The dashboard password could not be copied.'
      )
    }
  }

  function openDashboard(url: string): void {
    void openInBrowser(url)
  }

  function hasUpdate(gateway: GatewayStatus): boolean {
    return (
      gateway.installedVersion !== undefined &&
      gateway.availableVersion.length > 0 &&
      gateway.installedVersion !== gateway.availableVersion
    )
  }

  function applyStatus(status: GatewayStatus): void {
    const index = gateways.findIndex((gateway) => gateway.pluginId === status.pluginId)
    if (index === -1) gateways = [...gateways, status]
    else gateways = gateways.map((gateway) => (gateway.pluginId === status.pluginId ? status : gateway))
  }

  onMount(() => {
    void loadGateways()
    const unsubscribe = subscribe('gateway:state', (status) => {
      applyStatus(status)
    })
    return () => {
      unsubscribe()
    }
  })
</script>

<div class="mx-auto max-w-2xl space-y-5 p-6 pb-24">
  <div>
    <h1 class="text-xl font-bold tracking-tight">Gateways</h1>
    <p class="mt-0.5 text-sm text-muted">
      Managed local AI routers. CodeInOven installs, supervises, and exposes their models to every
      harness as custom providers.
    </p>
  </div>

  {#if error}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}
  {#if actionNotice}
    <p class="rounded-lg bg-success/10 px-3 py-2 text-xs text-success" role="status">
      {actionNotice}
    </p>
  {/if}

  {#if loading && gateways.length === 0}
    <div class="flex items-center gap-2 rounded-xl border bg-surface p-4 text-xs text-muted">
      <Loader2 size={14} class="animate-spin" />
      Inspecting gateways…
    </div>
  {:else}
    {#each gateways as gateway (gateway.pluginId)}
      {@const busy = busyPluginId === gateway.pluginId}
      <section class="rounded-xl border bg-surface p-4">
        <div class="flex items-start justify-between gap-4">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-base font-semibold">{gateway.adapterName}</h2>
              <span
                class="rounded-lg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide {lifecycleClass(
                  gateway.lifecycle
                )}"
              >
                {lifecycleLabels[gateway.lifecycle]}
              </span>
            </div>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              OpenAI- and Anthropic-compatible local router with provider fallbacks. Runs only on
              127.0.0.1 and is stopped when the app closes.
            </p>
          </div>
          <Switch
            checked={gateway.enabled}
            disabled={busy}
            onchange={(enabled) => void setEnabled(gateway.pluginId, enabled)}
            title={gateway.enabled
              ? `Disable the ${gateway.adapterName} gateway`
              : `Enable the ${gateway.adapterName} gateway`}
            aria-label={gateway.enabled
              ? `Disable the ${gateway.adapterName} gateway`
              : `Enable the ${gateway.adapterName} gateway`}
          />
        </div>

        <div class="mt-4 grid gap-3 sm:grid-cols-3">
          <div class="rounded-xl bg-elevated px-3 py-2.5">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Port</p>
            <p class="mt-1 text-sm font-medium tabular-nums">
              {gateway.port ?? '—'}
            </p>
          </div>
          <div class="rounded-xl bg-elevated px-3 py-2.5">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Models</p>
            <p class="mt-1 text-sm font-medium tabular-nums">{gateway.modelCount}</p>
          </div>
          <div class="rounded-xl bg-elevated px-3 py-2.5">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">Version</p>
            <p class="mt-1 text-sm font-medium">
              {gateway.installedVersion ?? gateway.availableVersion}
            </p>
          </div>
        </div>

        {#if gateway.detail}
          <div
            class="mt-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
          >
            <AlertTriangle size={14} class="mt-0.5 shrink-0" />
            <span class="break-all">{gateway.detail}</span>
          </div>
        {/if}

        {#if (gateway.lifecycle === 'installing' || gateway.lifecycle === 'starting') && gateway.progress}
          {@const progress = gateway.progress}
          <div class="mt-4">
            <div class="flex items-center justify-between text-xs">
              <span class="font-medium text-muted">
                {progress.phase === 'downloading'
                  ? `Downloading ${progress.detail ?? gateway.adapterName}`
                  : 'Installing packages'}
              </span>
              {#if progress.percent !== undefined}
                <span class="tabular-nums text-dimmed">{progress.percent}%</span>
              {/if}
            </div>
            <div
              class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-elevated"
              role="progressbar"
              aria-label="{gateway.adapterName} install progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress.percent ?? undefined}
            >
              {#if progress.percent !== undefined}
                <div
                  class="h-full rounded-full bg-primary transition-all"
                  style="width: {Math.max(2, progress.percent)}%"
                ></div>
              {:else}
                <div class="indeterminate-progress h-full w-1/3 rounded-full bg-primary"></div>
              {/if}
            </div>
            {#if progress.phase === 'downloading' && progress.downloadedBytes !== undefined && progress.totalBytes !== undefined}
              <p class="mt-1 text-right text-[11px] tabular-nums text-dimmed">
                {(progress.downloadedBytes / 1_048_576).toFixed(1)}
                /
                {(progress.totalBytes / 1_048_576).toFixed(1)}
                MB
              </p>
            {/if}
          </div>
        {/if}

        <div class="mt-4 flex flex-wrap gap-2">
          {#if gateway.lifecycle === 'ready'}
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
              disabled={busy}
              title="Stop the {gateway.adapterName} gateway"
              onclick={() => void stopGateway(gateway.pluginId)}
            >
              <Square size={14} />
              Stop
            </button>
          {:else if gateway.enabled}
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              disabled={busy}
              title="Install if needed and start the {gateway.adapterName} gateway"
              onclick={() => void startGateway(gateway.pluginId)}
            >
              {#if busy || gateway.lifecycle === 'starting' || gateway.lifecycle === 'installing'}
                <Loader2 size={14} class="animate-spin" />
              {:else}
                <Play size={14} />
              {/if}
              Start
            </button>
          {/if}
          <button
            type="button"
            class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
            disabled={busy || gateway.lifecycle !== 'ready'}
            title="Re-fetch the model catalog from the running gateway"
            onclick={() => void refreshCatalog(gateway.pluginId)}
          >
            <RefreshCw size={14} class={busy ? 'animate-spin' : ''} />
            Refresh models
          </button>
          {#if gateway.dashboardUrl && gateway.lifecycle === 'ready'}
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
              title="Open the {gateway.adapterName} dashboard"
              onclick={() => openDashboard(gateway.dashboardUrl ?? '')}
            >
              <ExternalLink size={14} />
              Open dashboard
            </button>
          {/if}
          {#if gateway.installedVersion !== undefined}
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
              disabled={busy}
              title="Copy the provisioned dashboard password"
              onclick={() => void copyDashboardPassword(gateway.pluginId)}
            >
              <Copy size={14} />
              Copy password
            </button>
          {/if}
          {#if hasUpdate(gateway)}
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 text-xs font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
              disabled={busy}
              title="Reinstall at version {gateway.availableVersion}"
              onclick={() => (updateTarget = gateway)}
            >
              <Upload size={14} />
              Update to {gateway.availableVersion}
            </button>
          {/if}
          {#if gateway.lifecycle === 'stopped' || gateway.lifecycle === 'error' || gateway.lifecycle === 'not_installed'}
            {#if gateway.lifecycle !== 'not_installed'}
              <button
                type="button"
                class="ml-auto flex h-9 items-center gap-2 rounded-lg border border-danger/30 bg-danger/5 px-3 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                disabled={busy}
                title="Uninstall the {gateway.adapterName} gateway and remove its data"
                onclick={() => (uninstallTarget = gateway)}
              >
                <Trash2 size={14} />
                Uninstall
              </button>
            {/if}
          {/if}
        </div>

        {#if gateway.dashboardUrl}
          <p class="mt-3 break-all font-mono text-[11px] text-dimmed">{gateway.dashboardUrl}</p>
        {/if}
      </section>
    {/each}
  {/if}
</div>

{#if uninstallTarget}
  <Modal
    title="Uninstall {uninstallTarget.adapterName}?"
    size="md"
    open
    onClose={() => (uninstallTarget = null)}
  >
    <div class="space-y-3 text-sm text-muted">
      <p>
        This stops the gateway, removes its app-owned installation and model catalog, and deletes
        the provider entries it synced into every harness. Provider connections configured through
        the gateway will stop working.
      </p>
      <p class="text-xs text-dimmed">
        Your gateway configuration data (providers set up inside the dashboard) is also removed.
        You can reinstall the gateway at any time.
      </p>
    </div>
    {#snippet footer()}
      <button
        type="button"
        class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay"
        title="Keep the gateway installed"
        onclick={() => (uninstallTarget = null)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg bg-danger px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        title="Confirm uninstalling the gateway"
        disabled={busyPluginId === uninstallTarget?.pluginId}
        onclick={() => {
          if (uninstallTarget) void uninstallGateway(uninstallTarget.pluginId)
        }}
      >
        {#if busyPluginId === uninstallTarget?.pluginId}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <Trash2 size={13} />
        {/if}
        Uninstall
      </button>
    {/snippet}
  </Modal>
{/if}

{#if updateTarget}
  <Modal
    title="Update {updateTarget.adapterName} to {updateTarget.availableVersion}?"
    size="md"
    open
    onClose={() => (updateTarget = null)}
  >
    <div class="space-y-3 text-sm text-muted">
      <p>
        The gateway is reinstalled at the pinned version
        <strong class="text-foreground">{updateTarget.availableVersion}</strong> (currently
        {updateTarget.installedVersion}). If it is running, it restarts automatically.
      </p>
      <p class="text-xs text-dimmed">
        Model catalogs are re-discovered after the update and harness providers are refreshed with
        the new catalog.
      </p>
    </div>
    {#snippet footer()}
      <button
        type="button"
        class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay"
        title="Skip this update"
        onclick={() => (updateTarget = null)}
      >
        Cancel
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        title="Confirm updating the gateway"
        disabled={busyPluginId === updateTarget?.pluginId}
        onclick={() => {
          if (updateTarget) void updateGateway(updateTarget.pluginId)
        }}
      >
        {#if busyPluginId === updateTarget?.pluginId}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <Upload size={13} />
        {/if}
        Update
      </button>
    {/snippet}
  </Modal>
{/if}

<style>
  .indeterminate-progress {
    animation: gateway-indeterminate 1.4s ease-in-out infinite;
  }
  @keyframes gateway-indeterminate {
    0% {
      transform: translateX(-100%);
    }
    100% {
      transform: translateX(400%);
    }
  }
</style>
