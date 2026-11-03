<script lang="ts">
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import {
    LOCAL_AI_UNLOAD_LABELS,
    LOCAL_AI_UNLOAD_OPTIONS,
    groupLlamaCppServers,
    isLocalAiUnloadOption,
    llamaCppEntryProblem,
    llamaCppServerAddress,
    nextFreeLlamaCppPort,
    type LlamaCppRuntimeStatus,
    type LlamaCppServerEntry,
    type LlamaCppServerGroup,
    type LocalAiRuntimeSummary
  } from '$shared/llama-cpp'
  import { uuidv7 } from '$shared/id'
  import { onMount } from 'svelte'
  import { toast } from 'svelte-sonner'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import LocalAiRuntimeCard from './local-ai/LocalAiRuntimeCard.svelte'
  import LocalAiRuntimeRow from './local-ai/LocalAiRuntimeRow.svelte'
  import LocalAiServerCard from './local-ai/LocalAiServerCard.svelte'
  import LocalAiServerModal from './local-ai/LocalAiServerModal.svelte'
  import { localAi } from './local-ai/local-ai-controller.svelte'
  import type { AppConfig, AppConfigPatch } from '$shared/types'

  interface Props {
    config: AppConfig
    settingsReady: boolean
    updateConfig: (patch: AppConfigPatch) => Promise<void>
  }

  let { config, settingsReady, updateConfig }: Props = $props()

  let runtime = $state<LlamaCppRuntimeStatus | null>(null)
  /** MLX and Core ML: the bundled workers, which the llama.cpp card does not cover. */
  let workerRuntimes = $state<LocalAiRuntimeSummary[]>([])
  let detecting = $state(false)
  let detectError = $state('')
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

  async function detect(): Promise<void> {
    detecting = true
    detectError = ''
    try {
      const [llama, runtimes] = await Promise.all([
        invoke('llamaCpp:detect'),
        invoke('localAi:runtimes')
      ])
      runtime = llama
      workerRuntimes = runtimes.filter((entry) => entry.id !== 'llama.cpp')
    } catch (error) {
      detectError = error instanceof Error ? error.message : 'Detection failed'
    } finally {
      detecting = false
    }
  }

  /**
   * The window every local model the app loads is held under. One setting for all
   * of them: the same model serves speech cleanup and search embeddings, so a
   * second window would only decide which feature reloads it first.
   */
  function setUnloadWindow(value: string): void {
    if (!isLocalAiUnloadOption(value)) return
    void updateConfig({ llamaCppUnload: value })
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

  /** Add another model to a server that already exists on this address. */
  function addModelTo(group: LlamaCppServerGroup): void {
    editing = { ...newEntry(), host: group.host, port: group.port }
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
    void detect()
    // A renderer reload leaves the main process's servers running; reattach to
    // the ones that answer instead of showing them as stopped.
    for (const entry of entries) void localAi.attach(entry)
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Local AI</h1>
    <p class="mt-0.5 text-sm leading-relaxed text-muted">
      This page owns local inference on this machine: the runtimes that can load a model, the
      llama-server rows you add, and the window an idle model is held in memory for. A server loads
      one model, either a GGUF file on disk or a Hugging Face repository, and listens on the host
      and port you give it.
    </p>
  </div>

  <section class="mb-3">
    <h2 class="text-sm font-semibold">Runtimes</h2>
    <p class="mt-0.5 text-xs leading-relaxed text-dimmed">
      Every engine this machine can drive. llama.cpp servers are started, shared, and unloaded by
      the local AI service, so speech cleanup and search embeddings run on one process; the MLX and
      Core ML workers are bundled into speech and keep their own windows on the Sound page.
    </p>
  </section>
  <div class="mb-8 @container space-y-2">
    <LocalAiRuntimeCard
      {runtime}
      {detecting}
      {detectError}
      onRefresh={() => void detect()}
      onChanged={() => void detect()}
    />
    {#each workerRuntimes as entry (entry.id)}
      <LocalAiRuntimeRow runtime={entry} icon="apple" />
    {/each}
  </div>

  <section class="mb-3">
    <h2 class="text-sm font-semibold">Model memory</h2>
    <p class="mt-0.5 text-xs leading-relaxed text-dimmed">
      A loaded llama.cpp model is kept resident so the next cleanup or search does not pay its load
      again, and released once this window passes without a use. A background index pass never
      extends it; only a cleanup, a search, or a warm-up does.
    </p>
  </section>
  <div class="mb-8">
    <label
      class="flex max-w-md items-center justify-between gap-3 border bg-surface p-4 text-xs text-muted"
    >
      Unload an idle model after
      <select
        class="border bg-elevated px-2.5 py-1.5 text-xs outline-none focus:border-primary"
        aria-label="Local AI idle model unload window"
        value={config.llamaCppUnload}
        disabled={!settingsReady}
        onchange={(event) => setUnloadWindow(event.currentTarget.value)}
      >
        {#each LOCAL_AI_UNLOAD_OPTIONS as option (option)}
          <option value={option}>{LOCAL_AI_UNLOAD_LABELS[option]}</option>
        {/each}
      </select>
    </label>
  </div>

  <div class="mb-3 flex items-end justify-between gap-4">
    <div>
      <h2 class="text-sm font-semibold">llama.cpp servers</h2>
      <p class="mt-0.5 text-xs leading-relaxed text-dimmed">
        Each row is one <code>llama-server</code> process. Expanding a row shows its live log.
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
        onclick={openCreate}
        disabled={!settingsReady || entries.length >= 32}
      >
        <CioPlus size={13} />
        Add server
      </button>
    </div>
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
    <div class="@container space-y-5">
      {#each groups as group (group.address)}
        <section class="space-y-2">
          <div
            class="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-1"
          >
            <p class="flex min-w-0 items-center gap-2 text-xs">
              <span class="truncate font-mono text-muted" title={group.address}
                >{group.address}</span
              >
              <span class="shrink-0 text-dimmed"
                >{group.entries.length}
                {group.entries.length === 1 ? 'model' : 'models'}</span
              >
            </p>
            <button
              type="button"
              class="shrink-0 px-1 py-0.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
              title="Add another model to the server on {group.address}"
              onclick={() => addModelTo(group)}
            >
              Add model
            </button>
          </div>
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
