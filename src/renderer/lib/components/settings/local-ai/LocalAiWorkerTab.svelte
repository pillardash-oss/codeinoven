<script lang="ts">
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import {
    MAX_LOCAL_AI_ENDPOINTS,
    type LlamaCppProbeResult,
    type LocalAiEndpoint,
    type LocalAiEndpointRuntime,
    type LocalAiRuntimeSummary
  } from '$shared/llama-cpp'
  import { uuidv7 } from '$shared/id'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import LocalAiEndpointModal from './LocalAiEndpointModal.svelte'
  import LocalAiRuntimeRow from './LocalAiRuntimeRow.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    runtime: LocalAiRuntimeSummary
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { runtime, config, settingsReady, updateConfig }: Props = $props()

  const runtimeId = $derived(runtime.id as LocalAiEndpointRuntime)
  const endpoints = $derived(
    (config.localAiEndpoints ?? []).filter((entry) => entry.runtime === runtimeId)
  )
  /** Live readiness per endpoint, keyed by endpoint id. */
  let probe = $state<Record<string, LlamaCppProbeResult>>({})
  let modalOpen = $state(false)
  let editing = $state<LocalAiEndpoint | null>(null)
  let creating = $state(false)
  let pendingDelete = $state<LocalAiEndpoint | null>(null)

  const label = $derived(runtimeId === 'mlx' ? 'MLX' : 'Core ML')

  function blankEndpoint(): LocalAiEndpoint {
    return {
      id: uuidv7(),
      runtime: runtimeId,
      name: '',
      host: '127.0.0.1',
      port: 8080,
      model: ''
    }
  }

  async function probeAll(): Promise<void> {
    const next: Record<string, LlamaCppProbeResult> = {}
    await Promise.all(
      endpoints.map(async (entry) => {
        try {
          next[entry.id] = await invoke('llamaCpp:probe', entry.host, entry.port)
        } catch {
          next[entry.id] = { ready: false, models: [], error: 'No answer' }
        }
      })
    )
    probe = next
  }

  async function save(endpoint: LocalAiEndpoint): Promise<void> {
    const others = (config.localAiEndpoints ?? []).filter((entry) => entry.id !== endpoint.id)
    await updateConfig({ localAiEndpoints: [...others, endpoint] })
    modalOpen = false
    toast.success(endpoint.name ? 'Server saved' : 'Server added', { description: endpoint.name })
    void probeAll()
  }

  async function remove(endpoint: LocalAiEndpoint): Promise<void> {
    await updateConfig({
      localAiEndpoints: (config.localAiEndpoints ?? []).filter((entry) => entry.id !== endpoint.id)
    })
    pendingDelete = null
    toast.success('Server removed', { description: endpoint.name })
  }

  function createCustomProvider(): void {
    baseUrlProviderFlow.open({ provider: null, defaultHarnessId: DEFAULT_HARNESS })
  }

  onMount(() => {
    void probeAll()
  })
</script>

<div class="space-y-4">
  <LocalAiRuntimeRow {runtime} icon="apple" />

  <section>
    <div class="mb-2 flex items-end justify-between gap-4">
      <div>
        <h2 class="text-sm font-semibold">Servers</h2>
        <p class="mt-0.5 text-xs text-dimmed">
          A {label} server you run, registered by its address.
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <button
          type="button"
          class="flex items-center gap-1.5 border bg-elevated px-2.5 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
          title="Open the custom base-URL provider editor and copy your server's address into it"
          onclick={createCustomProvider}
        >
          <CioPlug size={13} />
          Create Custom Provider
        </button>
        <button
          type="button"
          class="flex items-center gap-1.5 bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
          title="Register a {label} server that is already running"
          disabled={!settingsReady || endpoints.length >= MAX_LOCAL_AI_ENDPOINTS}
          onclick={() => {
            creating = true
            editing = blankEndpoint()
            modalOpen = true
          }}
        >
          <CioPlus size={13} />
          Add server
        </button>
      </div>
    </div>

    {#if endpoints.length === 0}
      <div class="border border-dashed px-4 py-8 text-center">
        <p class="text-sm text-muted">No server yet.</p>
        <p class="mt-1 text-xs text-dimmed">
          Start one with your {label} tooling, then add its address here.
        </p>
      </div>
    {:else}
      <ul class="space-y-2">
        {#each endpoints as endpoint (endpoint.id)}
          <li class="border bg-surface">
            <div class="flex items-start justify-between gap-3 p-3">
              <div class="min-w-0">
                <p class="truncate text-xs font-medium text-foreground">{endpoint.name}</p>
                <p class="mt-0.5 truncate font-mono text-xs text-muted">
                  {endpoint.host}:{endpoint.port}
                </p>
                <p class="mt-0.5 truncate text-xs text-dimmed">{endpoint.model}</p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <span
                  class="text-xs {probe[endpoint.id]?.ready ? 'text-success' : 'text-dimmed'}"
                  role="status"
                >
                  {probe[endpoint.id]?.ready ? 'Ready' : 'Not answering'}
                </span>
                <button
                  type="button"
                  class="px-1 py-0.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
                  title="Edit this server"
                  onclick={() => {
                    creating = false
                    editing = endpoint
                    modalOpen = true
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  class="px-1 py-0.5 text-xs text-danger transition-colors hover:bg-danger/10"
                  title="Remove this server"
                  onclick={() => (pendingDelete = endpoint)}
                >
                  Remove
                </button>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

{#if modalOpen && editing}
  <LocalAiEndpointModal
    runtime={runtimeId}
    initial={editing}
    isNew={creating}
    onClose={() => (modalOpen = false)}
    onSave={save}
  />
{/if}

<ConfirmDialog
  open={pendingDelete !== null}
  title="Remove server"
  confirmLabel="Remove"
  variant="danger"
  onCancel={() => (pendingDelete = null)}
  onConfirm={() => (pendingDelete ? remove(pendingDelete) : undefined)}
>
  <p class="text-sm leading-relaxed text-muted">
    {pendingDelete?.name ?? 'This server'} will be removed from the app. The process you started keeps
    running.
  </p>
</ConfirmDialog>
