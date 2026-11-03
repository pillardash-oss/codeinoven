<script lang="ts">
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import { uuidv7 } from '$shared/id'
  import {
    groupLlamaCppServers,
    llamaCppEntryProblem,
    llamaCppServerAddress,
    nextFreeLlamaCppPort,
    type LlamaCppRuntimeStatus,
    type LlamaCppServerEntry
  } from '$shared/llama-cpp'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import LocalAiRuntimeCard from './LocalAiRuntimeCard.svelte'
  import LocalAiServerCard from './LocalAiServerCard.svelte'
  import LocalAiServerModal from './LocalAiServerModal.svelte'
  import { localAi } from './local-ai-controller.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    runtime: LlamaCppRuntimeStatus | null
    detecting: boolean
    detectError: string
    onRefresh: () => void
    onChanged: () => void
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let {
    runtime,
    detecting,
    detectError,
    onRefresh,
    onChanged,
    config,
    settingsReady,
    updateConfig
  }: Props = $props()

  const entries = $derived(config.llamaCppServers ?? [])
  /** An address is the server; its saved models are the rows under it. */
  const groups = $derived(groupLlamaCppServers(entries))
  const executable = $derived(runtime?.path || 'llama-server')

  let expanded = $state<Record<string, boolean>>({})
  let modalOpen = $state(false)
  let modalKey = $state(0)
  let editing = $state<LlamaCppServerEntry | null>(null)
  let pendingDelete = $state<LlamaCppServerEntry | null>(null)
  /** The server the row being removed belongs to, so the dialog can say whether
   *  it removes a whole server or one of its models. */
  const pendingDeleteGroup = $derived.by(() => {
    const target = pendingDelete
    if (!target) return null
    const address = llamaCppServerAddress(target)
    return groups.find((group) => group.address === address) ?? null
  })

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
    const problem = llamaCppEntryProblem(entry)
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
    localAi.forget(entry.id)
    pendingDelete = null
    toast.success('Server removed', { description: entry.name })
  }

  function start(entry: LlamaCppServerEntry): void {
    expanded = { ...expanded, [entry.id]: true }
    void localAi.start(entry, executable)
  }

  function toggle(entryId: string): void {
    expanded = { ...expanded, [entryId]: !expanded[entryId] }
  }

  /**
   * A local server never writes to the provider registry. The user creates their
   * own custom base-URL provider, and this button is the handoff: it opens the
   * app's provider editor so the server's address can be copied into it.
   */
  function createCustomProvider(): void {
    baseUrlProviderFlow.open({ provider: null, defaultHarnessId: DEFAULT_HARNESS })
  }

  onMount(() => {
    // A renderer reload leaves the main process's servers running; reattach to
    // the ones that answer instead of showing them as stopped.
    for (const entry of entries) void localAi.attach(entry)
  })
</script>

<div class="space-y-4">
  <LocalAiRuntimeCard {runtime} {detecting} {detectError} {onRefresh} {onChanged} />

  <section>
    <div class="mb-2 flex items-end justify-between gap-4">
      <div>
        <h2 class="text-sm font-semibold">Servers</h2>
        <p class="mt-0.5 text-xs text-dimmed">One process per address. Expand a row for its log.</p>
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
          title="Add a llama.cpp server"
          onclick={openCreate}
          disabled={!settingsReady || entries.length >= 32}
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
          Point one at a GGUF file or a Hugging Face reference.
        </p>
      </div>
    {:else}
      <div class="@container space-y-5">
        {#each groups as group (group.address)}
          <section class="space-y-2">
            {#each group.entries as entry (entry.id)}
              <LocalAiServerCard
                {entry}
                {executable}
                status={localAi.statusOf(entry.id)}
                logLines={localAi.logOf(entry.id)}
                loadedModel={localAi.loadedModel[entry.id] ?? ''}
                notice={localAi.notice[entry.id] ?? ''}
                expanded={expanded[entry.id] ?? false}
                onToggle={() => toggle(entry.id)}
                onStart={() => start(entry)}
                onStop={() => void localAi.stop(entry.id)}
                onEdit={() => openEdit(entry)}
                onDelete={() => (pendingDelete = entry)}
              />
            {/each}
          </section>
        {/each}
      </div>
    {/if}
  </section>
</div>

{#if modalOpen && editing}
  {#key modalKey}
    <LocalAiServerModal
      initial={editing}
      {entries}
      {executable}
      onClose={() => (modalOpen = false)}
      onSave={save}
    />
  {/key}
{/if}

<ConfirmDialog
  open={pendingDelete !== null}
  title={(pendingDeleteGroup?.entries.length ?? 1) > 1 ? 'Remove model' : 'Remove server'}
  confirmLabel="Remove"
  variant="danger"
  onCancel={() => (pendingDelete = null)}
  onConfirm={() => (pendingDelete ? remove(pendingDelete) : undefined)}
>
  <p class="text-sm leading-relaxed text-muted">
    {pendingDelete?.name ?? 'This model'} will be removed from the app, and its process stopped if it
    is running. The model file on disk is left alone.
  </p>
  {#if pendingDelete && pendingDeleteGroup && pendingDeleteGroup.entries.length > 1}
    <p class="mt-2 text-sm leading-relaxed text-muted">
      The server on <span class="font-mono">{pendingDeleteGroup.address}</span> keeps its other
      {pendingDeleteGroup.entries.length - 1}
      {pendingDeleteGroup.entries.length - 1 === 1 ? 'model' : 'models'}.
    </p>
  {/if}
</ConfirmDialog>

<!-- One port serves one model at a time. A start on an address that already
     answers with another model stops that one, and the user is told which. -->
<ConfirmDialog
  open={localAi.pendingTakeover !== null}
  title="Start this model instead?"
  confirmLabel="Stop and start"
  onCancel={() => localAi.cancelTakeover()}
  onConfirm={() => void localAi.confirmTakeover()}
>
  <p class="text-sm leading-relaxed text-muted">
    <span class="font-mono">{localAi.pendingTakeover?.otherModel ?? 'Another model'}</span> is
    running on
    <span class="font-mono"
      >{localAi.pendingTakeover?.entry.host}:{localAi.pendingTakeover?.entry.port}</span
    >.
  </p>
  <p class="mt-2 text-sm leading-relaxed text-muted">
    That server is stopped first, then {localAi.pendingTakeover?.entry.name ?? 'this model'} loads on
    the same address.
  </p>
</ConfirmDialog>
