<script lang="ts">
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import {
    llamaCppEntryProblem,
    nextFreeLlamaCppPort,
    type LlamaCppRuntimeStatus,
    type LlamaCppServerEntry
  } from '$shared/llama-cpp'
  import { uuidv7 } from '$shared/id'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import LlamaCppBinaryCard from './llama-cpp/LlamaCppBinaryCard.svelte'
  import LlamaCppServerCard from './llama-cpp/LlamaCppServerCard.svelte'
  import LlamaCppServerModal from './llama-cpp/LlamaCppServerModal.svelte'
  import { llamaCpp } from './llama-cpp/llama-cpp-controller.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let runtime = $state<LlamaCppRuntimeStatus | null>(null)
  const entries = $derived(config.llamaCppServers ?? [])
  const executable = $derived(runtime?.path || 'llama-server')
  let detecting = $state(false)
  let detectError = $state('')
  let expanded = $state<Record<string, boolean>>({})
  let modalOpen = $state(false)
  let modalKey = $state(0)
  let editing = $state<LlamaCppServerEntry | null>(null)
  let pendingDelete = $state<LlamaCppServerEntry | null>(null)

  async function detect(): Promise<void> {
    detecting = true
    detectError = ''
    try {
      runtime = await invoke('llamaCpp:detect')
    } catch (error) {
      detectError = error instanceof Error ? error.message : 'Detection failed'
    } finally {
      detecting = false
    }
  }

  function newEntry(): LlamaCppServerEntry {
    return {
      id: uuidv7(),
      name: 'Local server',
      modelPath: '',
      modelReference: '',
      host: '127.0.0.1',
      port: nextFreeLlamaCppPort(entries),
      extraFlags: ''
    }
  }

  function openCreate(): void {
    editing = newEntry()
    modalKey++
    modalOpen = true
  }

  function openEdit(entry: LlamaCppServerEntry): void {
    editing = entry
    modalKey++
    modalOpen = true
  }

  async function save(entry: LlamaCppServerEntry): Promise<void> {
    const problem = llamaCppEntryProblem(entry, entries)
    if (problem) {
      toast.error(problem)
      return
    }
    const exists = entries.some((saved) => saved.id === entry.id)
    const next = exists
      ? entries.map((saved) => (saved.id === entry.id ? entry : saved))
      : [...entries, entry]
    await updateConfig({ llamaCppServers: next })
    modalOpen = false
    toast.success(exists ? 'Server updated' : 'Server added', { description: entry.name })
  }

  async function remove(entry: LlamaCppServerEntry): Promise<void> {
    await updateConfig({ llamaCppServers: entries.filter((saved) => saved.id !== entry.id) })
    llamaCpp.forget(entry.id)
    pendingDelete = null
    toast.success('Server removed', { description: entry.name })
  }

  function start(entry: LlamaCppServerEntry): void {
    expanded = { ...expanded, [entry.id]: true }
    void llamaCpp.start(entry, executable)
  }

  function toggle(entryId: string): void {
    expanded = { ...expanded, [entryId]: !expanded[entryId] }
  }

  /**
   * A start that actually answers makes the model available to the agent side:
   * the `llama-cpp` base-URL provider's discovered models are refreshed from the
   * endpoint itself, so no model list is written here and no second step is left.
   */
  async function refreshProvider(entry: LlamaCppServerEntry, modelId: string): Promise<void> {
    const projectId = rendererRecovery.selectedProjectId
    if (!projectId) return
    try {
      await invoke('llamaCpp:refreshProviderModels', projectId)
      toast.success('Model picker refreshed', {
        description: modelId || entry.name
      })
    } catch {
      // The server is running either way; the picker's own refresh still works.
      toast.message('Server ready', {
        description: 'Open the model picker and refresh to load the new model.'
      })
    }
  }

  onMount(() => {
    void detect()
    llamaCpp.onReady = (entry, modelId) => void refreshProvider(entry, modelId)
    // A renderer reload leaves the main process's servers running; reattach to
    // the ones that answer instead of showing them as stopped.
    for (const entry of entries) void llamaCpp.attach(entry)
    return () => {
      llamaCpp.onReady = null
    }
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Llama.cpp</h1>
    <p class="mt-0.5 text-sm text-muted">
      Local GGUF models served by <code>llama-server</code> on this machine, so a task can run without
      leaving it. The app owns the binary, the processes, and their logs.
    </p>
  </div>

  <div class="mb-8">
    <LlamaCppBinaryCard {runtime} {detecting} {detectError} onRefresh={() => void detect()} />
  </div>

  <div class="mb-3 flex items-end justify-between gap-4">
    <div>
      <h2 class="text-sm font-semibold">Servers</h2>
      <p class="mt-0.5 text-xs leading-relaxed text-dimmed">
        Each row is one <code>llama-server</code> process. Expanding a row shows its live log.
      </p>
    </div>
    <button
      type="button"
      class="flex shrink-0 items-center gap-1.5 border bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-opacity disabled:opacity-50"
      onclick={openCreate}
      disabled={!settingsReady || entries.length >= 32}
    >
      <CioPlus size={13} />
      Add server
    </button>
  </div>

  {#if entries.length === 0}
    <div class="border border-dashed px-4 py-10 text-center">
      <p class="text-sm text-muted">No local server yet.</p>
      <p class="mx-auto mt-1 max-w-md text-xs leading-relaxed text-dimmed">
        Add one from a Hugging Face reference or a GGUF file already on disk, then start it and
        watch its log fill in here.
      </p>
    </div>
  {:else}
    <div class="space-y-3">
      {#each entries as entry (entry.id)}
        <LlamaCppServerCard
          {entry}
          {executable}
          status={llamaCpp.statusOf(entry.id)}
          logLines={llamaCpp.logOf(entry.id)}
          loadedModel={llamaCpp.loadedModel[entry.id] ?? ''}
          notice={llamaCpp.notice[entry.id] ?? ''}
          expanded={expanded[entry.id] ?? false}
          onToggle={() => toggle(entry.id)}
          onStart={() => start(entry)}
          onStop={() => void llamaCpp.stop(entry.id)}
          onEdit={() => openEdit(entry)}
          onDelete={() => (pendingDelete = entry)}
        />
      {/each}
    </div>
  {/if}
</div>

{#if modalOpen && editing}
  {#key modalKey}
    <LlamaCppServerModal
      initial={editing}
      {entries}
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
    {pendingDelete?.name ?? 'This server'} will be removed from the app, and its process stopped if it
    is running. The model file on disk is left alone.
  </p>
</ConfirmDialog>
