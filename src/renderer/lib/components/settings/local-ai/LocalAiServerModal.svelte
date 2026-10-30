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
  import { tick } from 'svelte'
  import Modal from '../../ui/Modal.svelte'

  interface Props {
    initial: LlamaCppServerEntry
    entries: readonly LlamaCppServerEntry[]
    onClose: () => void
    onSave: (entry: LlamaCppServerEntry) => void | Promise<void>
  }

  let { initial, entries, onClose, onSave }: Props = $props()

  const fieldClass = 'w-full border bg-elevated px-3 py-2 text-sm text-foreground'

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
   * Which source the form is editing. This is user intent, not a fact derived
   * from the two fields: picking Hugging Face on an empty row has to show the
   * reference field at once, otherwise there is nowhere to paste the URL.
   */
  // svelte-ignore state_referenced_locally
  let source = $state<'local' | 'huggingface'>(
    initial.modelReference.trim().length > 0 ? 'huggingface' : 'local'
  )
  // svelte-ignore state_referenced_locally
  let advanced = $state(initial.host !== DEFAULT_LLAMA_CPP_HOST || initial.extraFlags.length > 0)
  let error = $state('')
  /**
   * The reference input itself, captured by an attachment: the Hugging Face
   * toggle exists to put the caret where the URL goes.
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
    isLlamaCppHostValid(draft.host) && isLlamaCppPortValid(draft.port)
      ? describeLlamaServerCommand(draft)
      : ''
  )

  async function chooseSource(next: 'local' | 'huggingface'): Promise<void> {
    if (source === next) return
    source = next
    error = ''
    if (next === 'huggingface') {
      // The reference field is the reason the toggle exists: put the caret in it.
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
    {#if error}<p class="text-sm text-danger" role="alert">{error}</p>{/if}

    <label class="block space-y-1 text-xs font-medium text-muted"
      >Name<input
        class={fieldClass}
        bind:value={name}
        required
        maxlength={120}
        placeholder="LFM2.5 local"
      /></label
    >

    <div class="space-y-2">
      <p class="text-xs font-medium text-muted">Model</p>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          class="border px-2 py-1 text-xs transition-colors {source === 'local'
            ? 'border-primary bg-primary/10 text-foreground'
            : 'text-muted hover:bg-elevated'}"
          aria-pressed={source === 'local'}
          onclick={() => void chooseSource('local')}
        >
          Local GGUF file
        </button>
        <button
          type="button"
          class="border px-2 py-1 text-xs transition-colors {source === 'huggingface'
            ? 'border-primary bg-primary/10 text-foreground'
            : 'text-muted hover:bg-elevated'}"
          aria-pressed={source === 'huggingface'}
          onclick={() => void chooseSource('huggingface')}
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
            class="flex shrink-0 items-center gap-1.5 whitespace-nowrap border px-3 py-2 text-xs hover:bg-elevated"
            onclick={() => void pickFile()}
          >
            <CioFolder size={13} />
            Choose file
          </button>
        </div>
        <p class="text-xs leading-relaxed text-dimmed">
          The file is referenced where it lives; nothing is copied.
        </p>
      {:else}
        <input
          class={fieldClass}
          {@attach captureReference}
          bind:value={modelReference}
          placeholder="LiquidAI/LFM2.5-2.6B-GGUF:Q5_K_M"
          aria-label="Hugging Face model reference"
        />
        {#if parsedReference}
          <p class="text-xs leading-relaxed text-dimmed">
            llama.cpp downloads <span class="font-mono"
              >{formatHuggingFaceModelReference(parsedReference)}</span
            >
            on first start.
          </p>
        {:else if modelReference.trim().length > 0}
          <p class="text-xs text-danger">
            Use <span class="font-mono">owner/repo</span>,
            <span class="font-mono">owner/repo:quant</span>, or a huggingface.co file URL.
          </p>
        {:else}
          <p class="text-xs leading-relaxed text-dimmed">
            Paste a repository such as <span class="font-mono">LiquidAI/LFM2.5-2.6B-GGUF</span>, a
            quant as <span class="font-mono">owner/repo:Q5_K_M</span>, or a specific file URL.
          </p>
        {/if}
      {/if}
    </div>

    <div class="space-y-2">
      <button
        type="button"
        class="text-xs font-medium text-muted transition-colors hover:text-foreground"
        aria-expanded={advanced}
        onclick={() => (advanced = !advanced)}
      >
        {advanced ? 'Hide advanced' : 'Advanced (host, port, flags)'}
      </button>
      {#if advanced}
        <div class="grid grid-cols-[minmax(0,1fr)_8rem] gap-2">
          <label class="block space-y-1 text-xs font-medium text-muted"
            >Host<input class={fieldClass} bind:value={host} placeholder="127.0.0.1" /></label
          >
          <label class="block space-y-1 text-xs font-medium text-muted"
            >Port<input
              class={fieldClass}
              bind:value={port}
              inputmode="numeric"
              placeholder="8080"
            /></label
          >
        </div>
        <label class="block space-y-1 text-xs font-medium text-muted"
          >Extra flags<input
            class={fieldClass}
            bind:value={extraFlags}
            placeholder="--ctx-size 8192 --threads 8"
          /></label
        >
      {/if}
    </div>

    {#if command}
      <p class="truncate border-t border-border pt-3 font-mono text-[0.625rem] text-dimmed">
        {command}
      </p>
    {/if}
  </form>

  {#snippet footer()}
    <div class="flex w-full flex-wrap items-center justify-between gap-2">
      <button
        type="button"
        data-modal-dismiss
        class="border px-3 py-2 text-sm hover:bg-elevated"
        onclick={onClose}>Cancel</button
      >
      <button
        type="submit"
        form="local-ai-server"
        data-modal-primary
        class="flex items-center gap-2 bg-primary px-3 py-2 text-sm font-medium text-on-primary disabled:opacity-50"
      >
        {editing ? 'Save server' : 'Add server'}
      </button>
    </div>
  {/snippet}
</Modal>
