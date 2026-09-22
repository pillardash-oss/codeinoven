<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import type { OpenCodeV2Catalog, OpenCodeV2DiscoveryResult } from '$shared/types'
  import { AlertTriangle, Boxes, Loader2, RefreshCw, Server, Sparkles } from '@lucide/svelte'
  import { onMount } from 'svelte'

  interface Props {
    /** Display name of the V2 harness row this panel belongs to. */
    harnessName: string
  }

  let { harnessName }: Props = $props()

  let result = $state<OpenCodeV2DiscoveryResult | null>(null)
  let loading = $state(true)

  const catalog = $derived<OpenCodeV2Catalog | null>(result?.ok ? result.catalog : null)
  const failure = $derived(result && !result.ok ? result : null)

  async function load(force: boolean): Promise<void> {
    loading = true
    try {
      result = await invoke('opencode2:discoverCatalog', force)
    } catch (error) {
      reportError(error, `Failed to read the ${harnessName} catalog`)
    } finally {
      loading = false
    }
  }

  onMount(() => {
    // The parent mounts this panel on demand, so one discovery per mount keeps
    // the expensive native server spawn out of the steady state.
    void load(false)
  })
</script>

<div class="space-y-2.5">
  <div class="flex items-center justify-between gap-3">
    <div class="min-w-0">
      <p class="text-xs font-semibold text-foreground">Read-only catalog</p>
      <p
        class="mt-0.5 text-[0.625rem] text-dimmed"
        title="Starts a private {harnessName} server on a loopback port, reads its providers, models, and agents, then stops it. Nothing is modified."
      >
        Providers, models, and agents read over the V2 API
      </p>
    </div>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
      title="Refresh the {harnessName} catalog"
      aria-label="Refresh the {harnessName} catalog"
      disabled={loading}
      onclick={() => void load(true)}
    >
      {#if loading}
        <Loader2 size={13} class="animate-spin" />
      {:else}
        <RefreshCw size={13} />
      {/if}
    </button>
  </div>

  {#if loading && !result}
    <p class="flex items-center gap-2 text-xs text-dimmed">
      <Loader2 size={13} class="animate-spin" /> Starting a private V2 server…
    </p>
  {:else if failure}
    <div class="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 p-2.5">
      <AlertTriangle size={14} class="mt-0.5 shrink-0 text-warning" />
      <div class="min-w-0">
        <p class="text-xs font-medium text-warning">
          {failure.reason === 'not-installed'
            ? `${harnessName} is not installed`
            : failure.reason === 'unsupported-version'
              ? 'Unrecognised V2 server response'
              : 'The V2 server could not be reached'}
        </p>
        <p class="mt-0.5 break-words font-mono text-[0.625rem] text-muted">{failure.detail}</p>
      </div>
    </div>
  {:else if catalog}
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem] text-muted">
      <span class="flex items-center gap-1.5">
        <Server size={12} class="text-dimmed" />
        v{catalog.server.version}
      </span>
      <span class="flex items-center gap-1.5">
        <Boxes size={12} class="text-dimmed" />
        {catalog.providers.length} provider{catalog.providers.length === 1 ? '' : 's'}
      </span>
      <span class="flex items-center gap-1.5">
        <Sparkles size={12} class="text-dimmed" />
        {catalog.models.length} model{catalog.models.length === 1 ? '' : 's'}
      </span>
      <span class="flex items-center gap-1.5">
        {catalog.agents.length} agent{catalog.agents.length === 1 ? '' : 's'}
      </span>
    </div>

    <div class="space-y-2">
      <p class="text-[0.625rem] font-medium tracking-wide text-dimmed uppercase">Providers</p>
      {#if catalog.providers.length === 0}
        <p class="text-xs text-dimmed">No providers registered.</p>
      {:else}
        <ul class="max-h-40 space-y-1 overflow-y-auto">
          {#each catalog.providers as provider (provider.id)}
            <li class="flex items-center justify-between gap-2 rounded-lg bg-raised px-2.5 py-1.5">
              <span class="min-w-0 truncate text-xs text-foreground" title={provider.id}>
                {provider.name}
              </span>
              <span class="shrink-0 text-[0.625rem] text-dimmed">{provider.activation}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="space-y-2">
      <p class="text-[0.625rem] font-medium tracking-wide text-dimmed uppercase">Models</p>
      {#if catalog.models.length === 0}
        <p class="text-xs text-dimmed">No models reported.</p>
      {:else}
        <ul class="max-h-64 space-y-1 overflow-y-auto">
          {#each catalog.models as model (model.id)}
            <li class="flex items-center justify-between gap-2 rounded-lg bg-raised px-2.5 py-1.5">
              <span
                class="min-w-0 truncate text-xs text-foreground"
                title="{model.id} · {model.providerId}"
              >
                {model.name}
              </span>
              <span class="shrink-0 text-[0.625rem] text-dimmed">
                {model.providerId}{#if model.contextLimit > 0}
                  · {Math.round(model.contextLimit / 1000)}k
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="space-y-2">
      <p class="text-[0.625rem] font-medium tracking-wide text-dimmed uppercase">Agents</p>
      {#if catalog.agents.length === 0}
        <p class="text-xs text-dimmed">No agents reported.</p>
      {:else}
        <ul class="max-h-40 space-y-1 overflow-y-auto">
          {#each catalog.agents.filter((agent) => !agent.hidden) as agent (agent.id)}
            <li class="flex items-center justify-between gap-2 rounded-lg bg-raised px-2.5 py-1.5">
              <span
                class="min-w-0 truncate text-xs text-foreground"
                title={agent.description ?? agent.id}
              >
                {agent.name}
              </span>
              <span class="shrink-0 text-[0.625rem] text-dimmed">{agent.mode}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
