<script lang="ts">
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    DEFAULT_LLAMA_CPP_HOST,
    describeLlamaServerCommand,
    formatHuggingFaceModelReference,
    isLlamaCppHostValid,
    isLlamaCppPortValid,
    llamaCppEntryProblem,
    parseHuggingFaceModelReference,
    type LlamaCppServerEntry
  } from '$shared/llama-cpp'
  import { uuidv7 } from '$shared/id'
  import Modal from '../../ui/Modal.svelte'

  interface Props {
    initial: LlamaCppServerEntry
    entries: readonly LlamaCppServerEntry[]
    onClose: () => void
    onSave: (entry: LlamaCppServerEntry) => void | Promise<void>
  }

  let { initial, entries, onClose, onSave }: Props = $props()

  // svelte-ignore state_referenced_locally
  const editing = entries.some((entry) => entry.id === initial.id)
  const fieldClass = 'w-full border bg-elevated px-3 py-2 text-sm text-foreground'

  // The page remounts this editor for every open, so the first values of
  // `initial` are exactly what the form should start from.
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
  let advanced = $state(false)
  let error = $state('')

  const source = $derived<'local' | 'huggingface'>(
    modelReference.trim().length > 0 && modelPath.trim().length === 0 ? 'huggingface' : 'local'
  )
  const parsedReference = $derived(
    modelReference.trim().length > 0 ? parseHuggingFaceModelReference(modelReference) : null
  )

  const draft = $derived<LlamaCppServerEntry>({
    id: initial.id || uuidv7(),
    name: name.trim(),
    modelPath: modelPath.trim(),
    modelReference: modelReference.trim(),
    host: host.trim(),
    port: Number(port),
    extraFlags: extraFlags.trim()
  })

  const command = $derived(
    isLlamaCppHostValid(draft.host) && isLlamaCppPortValid(draft.port)
      ? describeLlamaServerCommand(draft)
      : ''
  )

  function pickFile(): void {
    void (async () => {
      const path = await invoke('llamaCpp:pickModel')
      if (!path) return
      modelPath = path
      modelReference = ''
      if (!name.trim() || name.trim() === 'Local server') {
        const segments = path.split(/[\\/]/u)
        name = segments[segments.length - 1] ?? name
      }
    })()
  }

  function chooseSource(next: 'local' | 'huggingface'): void {
    if (next === 'local') modelReference = ''
    else modelPath = ''
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
    id="llama-cpp-server"
    class="space-y-4"
    onsubmit={(event) => {
      event.preventDefault()
      submit()
    }}
  >
    <label class="block">
      <span class="mb-1 block text-xs font-medium text-muted">Name</span>
      <input class={fieldClass} bind:value={name} placeholder="LFM2.5 local" />
    </label>

    <div>
      <span class="mb-1 block text-xs font-medium text-muted">Model</span>
      <div class="mb-2 flex gap-2">
        <button
          type="button"
          class="border px-3 py-1 text-xs font-medium transition-colors {source === 'local'
            ? 'border-primary bg-primary/10 text-foreground'
            : 'text-muted hover:bg-elevated'}"
          onclick={() => chooseSource('local')}
        >
          Local GGUF file
        </button>
        <button
          type="button"
          class="border px-3 py-1 text-xs font-medium transition-colors {source === 'huggingface'
            ? 'border-primary bg-primary/10 text-foreground'
            : 'text-muted hover:bg-elevated'}"
          onclick={() => chooseSource('huggingface')}
        >
          Hugging Face
        </button>
      </div>

      {#if source === 'local'}
        <div class="flex gap-2">
          <input
            class={fieldClass}
            bind:value={modelPath}
            placeholder="/path/to/model.gguf"
            aria-label="Path of the GGUF model"
          />
          <button
            type="button"
            class="flex shrink-0 items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
            onclick={pickFile}
          >
            <CioFolder size={13} />
            Choose
          </button>
        </div>
        <p class="mt-1 text-xs leading-relaxed text-dimmed">
          The file is referenced where it lives; nothing is copied.
        </p>
      {:else}
        <input
          class={fieldClass}
          bind:value={modelReference}
          placeholder="LiquidAI/LFM2.5-2.6B-GGUF:Q5_K_M"
          aria-label="Hugging Face model reference"
        />
        {#if parsedReference}
          <p class="mt-1 text-xs leading-relaxed text-dimmed">
            llama.cpp will download <span class="font-mono"
              >{formatHuggingFaceModelReference(parsedReference)}</span
            >
            on first start.
          </p>
        {:else if modelReference.trim().length > 0}
          <p class="mt-1 text-xs text-danger">
            Use <span class="font-mono">owner/repo</span>,
            <span class="font-mono">owner/repo:quant</span>, or a huggingface.co file URL.
          </p>
        {:else}
          <p class="mt-1 text-xs leading-relaxed text-dimmed">
            Paste a repository such as <span class="font-mono">LiquidAI/LFM2.5-2.6B-GGUF</span> or a specific
            file URL.
          </p>
        {/if}
      {/if}
    </div>

    <div>
      <button
        type="button"
        class="text-xs font-medium text-muted underline-offset-2 hover:text-foreground hover:underline"
        onclick={() => (advanced = !advanced)}
      >
        {advanced ? 'Hide advanced' : 'Advanced'}
      </button>
      {#if advanced}
        <div class="mt-2 grid grid-cols-[1fr_8rem] gap-2">
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-muted">Host</span>
            <input class={fieldClass} bind:value={host} placeholder="127.0.0.1" />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-medium text-muted">Port</span>
            <input class={fieldClass} bind:value={port} inputmode="numeric" placeholder="8080" />
          </label>
        </div>
        <label class="mt-2 block">
          <span class="mb-1 block text-xs font-medium text-muted">Extra flags</span>
          <input
            class={fieldClass}
            bind:value={extraFlags}
            placeholder="--ctx-size 8192 --threads 8"
          />
        </label>
      {/if}
    </div>

    {#if command}
      <p class="truncate border-t pt-3 font-mono text-[0.6875rem] text-dimmed" title={command}>
        {command}
      </p>
    {/if}
    {#if error}
      <p class="text-xs text-danger" role="alert">{error}</p>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-3">
      <button
        type="button"
        class="border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        type="submit"
        form="llama-cpp-server"
        class="border bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-opacity"
      >
        {editing ? 'Save server' : 'Add server'}
      </button>
    </div>
  {/snippet}
</Modal>
