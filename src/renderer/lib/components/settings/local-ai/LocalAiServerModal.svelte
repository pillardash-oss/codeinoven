<script lang="ts">
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import { panelReveal } from '$lib/components/layout/page-reveal'
  import { invoke } from '$lib/ipc.svelte'
  import {
    DEFAULT_LLAMA_CPP_HOST,
    buildLlamaServerArgs,
    describeLlamaServerCommand,
    formatHuggingFaceModelReference,
    llamaCppEntryProblem,
    parseHuggingFaceModelReference,
    type LlamaCppServerEntry
  } from '$shared/llama-cpp'
  import { uuidv7 } from '$shared/id'
  import { tick } from 'svelte'
  import { fly } from 'svelte/transition'
  import Modal from '../../ui/Modal.svelte'

  interface Props {
    initial: LlamaCppServerEntry
    entries: readonly LlamaCppServerEntry[]
    onClose: () => void
    onSave: (entry: LlamaCppServerEntry) => void | Promise<void>
  }

  let { initial, entries, onClose, onSave }: Props = $props()

  const fieldClass = 'h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary'
  const monoFieldClass =
    'h-9 w-full border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary'

  // The page remounts this editor for every open, so the first values of
  // `initial` are exactly what the form should start from.
  // svelte-ignore state_referenced_locally
  const editing = entries.some((entry) => entry.id === initial.id)
  // svelte-ignore state_referenced_locally
  let name = $state(initial.name)
  // svelte-ignore state_referenced_locally
  let modelPath = $state(initial.modelPath)
  // svelte-ignore state_referenced_locally
  let modelReference = $state(initial.modelReference)
  // svelte-ignore state_referenced_locally
  let host = $state(initial.host || DEFAULT_LLAMA_CPP_HOST)
  // svelte-ignore state_referenced_locally
  let port = $state(String(initial.port))
  // svelte-ignore state_referenced_locally
  let extraFlags = $state(initial.extraFlags)

  /**
   * Which model source the user is filling in. This is intent, not a fact read
   * back from the two fields: the choice has to hold on an empty row, where
   * both fields are still blank and the reference field must open for a paste.
   */
  // svelte-ignore state_referenced_locally
  let source = $state<'local' | 'huggingface'>(
    initial.modelReference.trim().length > 0 ? 'huggingface' : 'local'
  )
  let error = $state('')

  /**
   * The reference input, captured by an attachment: choosing Hugging Face is
   * only useful if the caret lands where the URL goes.
   */
  let referenceField: HTMLInputElement | undefined
  function captureReference(node: HTMLInputElement): () => void {
    referenceField = node
    return () => {
      referenceField = undefined
    }
  }

  const parsedReference = $derived(
    modelReference.trim().length > 0 ? parseHuggingFaceModelReference(modelReference) : null
  )

  const draft = $derived<LlamaCppServerEntry>({
    id: initial.id || uuidv7(),
    name: name.trim(),
    modelPath: source === 'local' ? modelPath.trim() : '',
    modelReference: source === 'huggingface' ? modelReference.trim() : '',
    host: host.trim(),
    port: Number(port),
    extraFlags: extraFlags.trim()
  })

  const command = $derived(
    buildLlamaServerArgs(draft).length > 0 ? describeLlamaServerCommand(draft) : ''
  )

  const sourceChoices: Array<{
    id: 'local' | 'huggingface'
    title: string
    hint: string
    icon: typeof CioFolder
  }> = [
    {
      id: 'local',
      title: 'Local GGUF file',
      hint: 'A file already on this machine, referenced where it lives.',
      icon: CioFolder
    },
    {
      id: 'huggingface',
      title: 'Hugging Face',
      hint: 'llama.cpp downloads the model on the first start.',
      icon: CioDownload
    }
  ]

  async function chooseSource(next: 'local' | 'huggingface'): Promise<void> {
    if (source === next) return
    source = next
    error = ''
    if (next === 'huggingface') {
      await tick()
      referenceField?.focus()
    }
  }

  async function pickFile(): Promise<void> {
    const path = await invoke('llamaCpp:pickModel')
    if (!path) return
    modelPath = path
    if (!name.trim() || name.trim() === 'Local server') {
      const segments = path.split(/[\\/]/u)
      name = segments[segments.length - 1] ?? name
    }
  }

  function submit(): void {
    const problem = llamaCppEntryProblem(draft, entries)
    if (problem) {
      error = problem
      return
    }
    error = ''
    void onSave(draft)
  }
</script>

<Modal open title={editing ? 'Edit server' : 'Add server'} {onClose} size="lg">
  <form
    id="local-ai-server"
    class="space-y-4"
    onsubmit={(event) => {
      event.preventDefault()
      submit()
    }}
  >
    {#if error}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}

    <div class="border bg-raised p-4">
      <p class="text-sm font-semibold">A llama-server process on this machine</p>
      <p class="mt-1 text-xs leading-relaxed text-muted">
        One row is one model served on a port. The app starts it, streams its log, and offers the
        loaded model to your agent through the llama-cpp provider.
      </p>
    </div>

    <fieldset class="space-y-3 border p-3">
      <legend class="px-1 text-xs font-semibold">Server</legend>
      <label class="block space-y-1 text-xs font-medium">
        <span>Name</span>
        <input class={fieldClass} bind:value={name} required maxlength={120} placeholder="LFM2.5" />
      </label>
    </fieldset>

    <fieldset class="space-y-3 border p-3">
      <legend class="px-1 text-xs font-semibold">Model</legend>
      <div class="grid gap-2 md:grid-cols-2">
        {#each sourceChoices as choice (choice.id)}
          <button
            type="button"
            class="group border p-3 text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {source ===
            choice.id
              ? 'border-primary bg-primary/10'
              : 'bg-elevated'}"
            aria-pressed={source === choice.id}
            onclick={() => void chooseSource(choice.id)}
          >
            <span class="flex items-center gap-2">
              <choice.icon size={14} class="shrink-0 text-muted group-hover:text-foreground" />
              <span class="text-xs font-semibold">{choice.title}</span>
            </span>
            <span class="mt-1 block text-[0.6875rem] leading-relaxed text-muted">
              {choice.hint}
            </span>
          </button>
        {/each}
      </div>

      {#key source}
        <!-- Intro only: the outgoing source leaves in the same frame the
             arriving one rises, so the fieldset never holds both blocks. -->
        <div class="space-y-3" in:fly={panelReveal()}>
          {#if source === 'local'}
            <div class="flex gap-2">
              <input
                class={`${monoFieldClass} min-w-0 flex-1`}
                bind:value={modelPath}
                placeholder="/path/to/model.gguf"
                aria-label="Path of the GGUF model"
              />
              <button
                type="button"
                class="flex h-9 shrink-0 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
                onclick={() => void pickFile()}
              >
                <CioFolder size={13} />
                Choose file
              </button>
            </div>
          {:else}
            <label class="block space-y-1 text-xs font-medium">
              <span>Reference</span>
              <input
                class={monoFieldClass}
                {@attach captureReference}
                bind:value={modelReference}
                placeholder="LiquidAI/LFM2.5-2.6B-GGUF:Q5_K_M"
              />
            </label>
            {#if parsedReference}
              <p class="text-[0.6875rem] leading-relaxed text-muted">
                llama.cpp downloads <span class="font-mono"
                  >{formatHuggingFaceModelReference(parsedReference)}</span
                >
                on the first start.
              </p>
            {:else if modelReference.trim().length > 0}
              <p class="text-[0.6875rem] text-danger">
                Use <span class="font-mono">owner/repo</span>,
                <span class="font-mono">owner/repo:quant</span>, or a huggingface.co file URL.
              </p>
            {:else}
              <p class="text-[0.6875rem] leading-relaxed text-muted">
                Paste <span class="font-mono">LiquidAI/LFM2.5-2.6B-GGUF</span>, a quant
                <span class="font-mono">owner/repo:Q5_K_M</span>, or a specific file URL.
              </p>
            {/if}
          {/if}
        </div>
      {/key}
    </fieldset>

    <fieldset class="space-y-3 border p-3">
      <legend class="px-1 text-xs font-semibold">Connection</legend>
      <div class="grid grid-cols-[minmax(0,1fr)_7rem] gap-2">
        <label class="block space-y-1 text-xs font-medium">
          <span>Host</span>
          <input class={monoFieldClass} bind:value={host} placeholder="127.0.0.1" />
        </label>
        <label class="block space-y-1 text-xs font-medium">
          <span>Port</span>
          <input class={monoFieldClass} bind:value={port} inputmode="numeric" placeholder="8080" />
        </label>
      </div>
      <label class="block space-y-1 text-xs font-medium">
        <span>Extra flags · one per line</span>
        <textarea
          class="min-h-16 w-full border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
          bind:value={extraFlags}
          placeholder="--ctx-size 8192&#10;--threads 8"></textarea>
      </label>
      <p class="text-[0.6875rem] leading-relaxed text-muted">
        A host of <span class="font-mono">127.0.0.1</span> keeps the server on this machine;
        <span class="font-mono">0.0.0.0</span> exposes it to your network. Quoting keeps a value
        together, so <span class="font-mono">--alias "my local model"</span> stays one argument.
      </p>
    </fieldset>

    {#if command}
      <div class="border bg-raised p-3">
        <p class="text-[0.6875rem] font-medium uppercase tracking-wide text-dimmed">Command</p>
        <p class="mt-1 break-all font-mono text-[0.6875rem] leading-relaxed text-muted">
          {command}
        </p>
      </div>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-2">
      <button
        type="button"
        data-modal-dismiss
        class="h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        type="submit"
        form="local-ai-server"
        data-modal-primary
        class="flex h-9 items-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      >
        {editing ? 'Save server' : 'Add server'}
      </button>
    </div>
  {/snippet}
</Modal>
