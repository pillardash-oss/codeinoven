<script lang="ts">
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import { uuidv7 } from '$shared/id'
  import {
    MAX_LLAMA_CPP_SERVERS,
    llamaCppEntryProblem,
    nextFreeLlamaCppPort,
    type LlamaCppServerEntry,
    type LocalAiRuntimeId,
    type LocalAiRuntimeSummary
  } from '$shared/llama-cpp'
  import { toast } from 'svelte-sonner'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import LocalAiRuntimeRow from './LocalAiRuntimeRow.svelte'
  import LocalAiServerCard from './LocalAiServerCard.svelte'
  import LocalAiServerModal from './LocalAiServerModal.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    runtime: LocalAiRuntimeSummary
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { runtime, config, settingsReady, updateConfig }: Props = $props()

  const runtimeId = $derived(runtime.id as LocalAiRuntimeId)
  /** The same saved rows the llama.cpp tab reads, narrowed to this engine. */
  const entries = $derived((config.llamaCppServers ?? []).filter((e) => e.runtime === runtimeId))
  const label = $derived(runtimeId === 'mlx' ? 'MLX' : 'Core ML')
  const executable = $derived('')

  let modalOpen = $state(false)
  let modalKey = $state(0)
  let editing = $state<LlamaCppServerEntry | null>(null)
  let pendingDelete = $state<LlamaCppServerEntry | null>(null)

  function newEntry(): LlamaCppServerEntry {
    return {
      id: uuidv7(),
      runtime: runtimeId,
      name: '',
      modelPath: '',
      modelReference: '',
      host: '127.0.0.1',
      port: nextFreeLlamaCppPort(config.llamaCppServers ?? []),
      extraFlags: ''
    }
  }

  async function save(entry: LlamaCppServerEntry): Promise<void> {
    const problem = llamaCppEntryProblem(entry)
    if (problem) {
      toast.error(problem)
      return
    }
    const saved = config.llamaCppServers ?? []
    const exists = saved.some((candidate) => candidate.id === entry.id)
    await updateConfig({
      llamaCppServers: exists
        ? saved.map((candidate) => (candidate.id === entry.id ? entry : candidate))
        : [...saved, entry]
    })
    modalOpen = false
    toast.success(exists ? 'Server updated' : 'Server added', { description: entry.name })
  }

  async function remove(entry: LlamaCppServerEntry): Promise<void> {
    await updateConfig({
      llamaCppServers: (config.llamaCppServers ?? []).filter((saved) => saved.id !== entry.id)
    })
    pendingDelete = null
    toast.success('Server removed', { description: entry.name })
  }

  function createCustomProvider(): void {
    baseUrlProviderFlow.open({ provider: null, defaultHarnessId: DEFAULT_HARNESS })
  }
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
          title="Add a {label} server"
          disabled={!settingsReady || entries.length >= MAX_LLAMA_CPP_SERVERS}
          onclick={() => {
            editing = newEntry()
            modalKey++
            modalOpen = true
          }}
        >
          <CioPlus size={13} />
          Add server
        </button>
      </div>
    </div>

    {#if entries.length === 0}
      <div class="border border-dashed px-4 py-8 text-center">
        <p class="text-sm text-muted">No server yet.</p>
        <p class="mt-1 text-xs text-dimmed">
          Start one with your {label} tooling, then add its address here.
        </p>
      </div>
    {:else}
      <div class="@container space-y-2">
        {#each entries as entry (entry.id)}
          <LocalAiServerCard
            {entry}
            {executable}
            status="stopped"
            logLines={[]}
            loadedModel={entry.modelPath || entry.modelReference}
            notice=""
            expanded={false}
            managed={false}
            onToggle={() => {}}
            onStart={() => {}}
            onStop={() => {}}
            onEdit={() => {
              editing = entry
              modalKey++
              modalOpen = true
            }}
            onDelete={() => (pendingDelete = entry)}
          />
        {/each}
      </div>
    {/if}
  </section>
</div>

{#if modalOpen && editing}
  {#key modalKey}
    <LocalAiServerModal
      runtime={runtimeId}
      initial={editing}
      entries={config.llamaCppServers ?? []}
      {executable}
      onClose={() => (modalOpen = false)}
      onSave={save}
    />
  {/key}
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
