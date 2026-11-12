<script lang="ts">
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import { uuidv7 } from '$shared/id'
  import {
    groupLlamaCppServers,
    llamaCppServerAddress,
    localAiEntryProblem,
    localAiModelCopy,
    localAiServerCommandName,
    nextFreeLlamaCppPort,
    type LlamaCppServerEntry,
    type LocalAiModelLocation,
    type LocalAiRuntimeId,
    type LocalAiRuntimeStatus
  } from '$shared/llama-cpp'
  import { onDestroy, onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import LocalAiRuntimeCard from './LocalAiRuntimeCard.svelte'
  import LocalAiServerCard from './LocalAiServerCard.svelte'
  import LocalAiServerModal from './LocalAiServerModal.svelte'
  import { localAi } from './local-ai-controller.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    runtime: LocalAiRuntimeId
    status: LocalAiRuntimeStatus | null
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
    status,
    detecting,
    detectError,
    onRefresh,
    onChanged,
    config,
    settingsReady,
    updateConfig
  }: Props = $props()

  /** Every saved row of both engines: an address is shared by the whole page. */
  const saved = $derived(config.llamaCppServers ?? [])

  /** The same saved rows every engine tab reads, narrowed to this engine. */
  const entries = $derived(saved.filter((e) => e.runtime === runtime))
  /** An address is the server; its saved models are the rows under it. */
  const groups = $derived(groupLlamaCppServers(entries))
  const label = $derived(runtime === 'mlx' ? 'MLX' : 'llama.cpp')
  const copy = $derived(localAiModelCopy(runtime))
  const executable = $derived(status?.path || localAiServerCommandName(runtime))

  let modalOpen = $state(false)
  let modalKey = $state(0)
  let editing = $state<LlamaCppServerEntry | null>(null)
  let pendingDelete = $state<LlamaCppServerEntry | null>(null)
  let expanded = $state<Record<string, boolean>>({})
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
      runtime,
      name: 'Local server',
      modelPath: '',
      modelReference: '',
      host: '127.0.0.1',
      port: nextFreeLlamaCppPort(saved),
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
    const problem = localAiEntryProblem(entry)
    if (problem) {
      toast.error(problem)
      return
    }
    const exists = entries.some((saved) => saved.id === entry.id)
    const next = exists
      ? entries.map((saved) => (saved.id === entry.id ? entry : saved))
      : [...entries, entry]
    // The page holds rows for both engines in one list, so this tab writes back
    // its own rows and leaves the other engine's untouched.
    await updateConfig({
      llamaCppServers: [...saved.filter((e) => e.runtime !== runtime), ...next]
    })
    modalOpen = false
    toast.success(exists ? 'Server updated' : 'Server added', { description: entry.name })
  }

  async function remove(entry: LlamaCppServerEntry): Promise<void> {
    await updateConfig({
      llamaCppServers: saved.filter((savedEntry) => savedEntry.id !== entry.id)
    })
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
   * Open the row's model in the OS file manager, and say so when the path is
   * gone instead of leaving the click unanswered.
   */
  async function reveal(entry: LlamaCppServerEntry): Promise<void> {
    if (await localAi.revealModel(entry)) return
    toast.error('Could not open the file manager', {
      description: `${entry.modelPath.trim()} could not be found on disk.`
    })
  }

  // A row's weights are measured once per path, by the main process: the card's
  // size column only reads what this page has already asked for.
  $effect(() => {
    for (const entry of entries) void localAi.loadModelSize(entry.modelPath.trim())
  })

  /**
   * A local server never writes to the provider registry. The user creates their
   * own custom base-URL provider, and this button is the handoff: it opens the
   * app's provider editor so the server's address can be copied into it.
   */
  function createCustomProvider(): void {
    baseUrlProviderFlow.open({ provider: null, defaultHarnessId: DEFAULT_HARNESS })
  }

  /**
   * Write the folder a finished download landed in into the saved row.
   *
   * A row saved from a Hugging Face tag is a tag only until the weights exist; from
   * then on the folder is what the next start loads, which is what keeps a
   * multi-gigabyte model from being fetched again. The record is only rewritten
   * when it still names the tag that was downloaded, so a row the user edited
   * meanwhile is left alone.
   */
  async function saveLocalizedModel(
    entry: LlamaCppServerEntry,
    location: LocalAiModelLocation
  ): Promise<void> {
    const saved = config.llamaCppServers ?? []
    const current = saved.find((candidate) => candidate.id === entry.id)
    if (!current || current.modelReference !== entry.modelReference) return
    await updateConfig({
      llamaCppServers: saved.map((candidate) =>
        candidate.id === entry.id
          ? { ...candidate, modelPath: location.path, modelReference: '' }
          : candidate
      )
    })
    toast.success('Model saved locally', { description: location.path })
  }

  onMount(() => {
    // Only one engine tab is mounted at a time, so this is the handler for the
    // rows on screen.
    localAi.onModelLocalized = (entry, location) => void saveLocalizedModel(entry, location)
    // A renderer reload leaves the main process's servers running; reattach to
    // the ones that answer instead of showing them as stopped.
    for (const entry of entries) void localAi.attach(entry)
  })

  onDestroy(() => {
    localAi.onModelLocalized = null
  })
</script>

<div class="space-y-4">
  <LocalAiRuntimeCard {runtime} {status} {detecting} {detectError} {onRefresh} {onChanged} />

  <section>
    <div class="mb-2 flex items-end justify-between gap-4">
      <div>
        <h2 class="text-sm font-semibold">Servers</h2>
        <p class="mt-0.5 text-xs text-dimmed">
          One {label} process per address. Expand a row for its output.
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
          title="Add an {label} server"
          onclick={openCreate}
          disabled={!settingsReady || saved.length >= 32}
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
          {runtime === 'mlx'
            ? 'Point one at an MLX model folder or a Hugging Face repository.'
            : 'Point one at a GGUF file or a Hugging Face reference.'}
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
                modelSize={localAi.sizeOf(entry.modelPath.trim())}
                notice={localAi.notice[entry.id] ?? ''}
                expanded={expanded[entry.id] ?? false}
                onToggle={() => toggle(entry.id)}
                onStart={() => start(entry)}
                onStop={() => void localAi.stop(entry.id)}
                onEdit={() => openEdit(entry)}
                onDelete={() => (pendingDelete = entry)}
                onReveal={() => void reveal(entry)}
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
      {runtime}
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
    is running. {copy.localTitle === 'Local GGUF file'
      ? 'The model file on disk'
      : 'The model folder on disk'}
    is left alone.
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
    <span class="font-mono">{localAi.pendingTakeover?.otherModel || 'Another model'}</span> is
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
