<script lang="ts">
  import { onMount } from 'svelte'
  import { AlertTriangle, Loader2, Play, RefreshCw, Square } from '@lucide/svelte'
  import type { GatewayStatus } from '$shared/gateway-types'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import Switch from '../ui/Switch.svelte'

  let gateways = $state<GatewayStatus[]>([])
  let loading = $state(true)
  let busyPluginId = $state<string | null>(null)
  let error = $state('')
  let actionNotice = $state('')

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
        </div>

        {#if gateway.dashboardUrl}
          <p class="mt-3 break-all font-mono text-[11px] text-dimmed">{gateway.dashboardUrl}</p>
        {/if}
      </section>
    {/each}
  {/if}
</div>
