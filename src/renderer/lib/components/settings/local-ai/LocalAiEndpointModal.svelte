<script lang="ts">
  import {
    DEFAULT_LLAMA_CPP_HOST,
    type LocalAiEndpoint,
    type LocalAiEndpointRuntime
  } from '$shared/llama-cpp'
  import Modal from '../../ui/Modal.svelte'

  interface Props {
    runtime: LocalAiEndpointRuntime
    /** The draft this modal edits: an existing row, or a blank one for a new server. */
    initial: LocalAiEndpoint
    isNew: boolean
    onClose: () => void
    onSave: (endpoint: LocalAiEndpoint) => void
  }

  let { runtime, initial, isNew, onClose, onSave }: Props = $props()

  // The page remounts this editor for every open, so the first values of
  // `initial` are exactly what the form starts from.
  // svelte-ignore state_referenced_locally
  const editing = !isNew
  // svelte-ignore state_referenced_locally
  let name = $state(initial.name)
  // svelte-ignore state_referenced_locally
  let host = $state(initial.host || DEFAULT_LLAMA_CPP_HOST)
  // svelte-ignore state_referenced_locally
  let port = $state(String(initial.port))
  // svelte-ignore state_referenced_locally
  let model = $state(initial.model)
  let error = $state('')

  const label = $derived(runtime === 'mlx' ? 'MLX' : 'Core ML')

  function submit(): void {
    const portNumber = Number.parseInt(port.trim(), 10)
    if (!name.trim()) {
      error = 'A name is required'
      return
    }
    if (!host.trim()) {
      error = 'A host is required'
      return
    }
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
      error = 'A port between 1 and 65535 is required'
      return
    }
    if (!model.trim()) {
      error = 'The model id the server answers with is required'
      return
    }
    error = ''
    onSave({
      id: initial.id,
      runtime,
      name: name.trim(),
      host: host.trim(),
      port: portNumber,
      model: model.trim()
    })
  }
</script>

<Modal open title={editing ? `Edit ${label} server` : `Add ${label} server`} {onClose} size="md">
  <form
    id="local-ai-endpoint"
    class="space-y-4"
    onsubmit={(event) => {
      event.preventDefault()
      submit()
    }}
  >
    {#if error}
      <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}

    <label class="block">
      <span class="mb-1 block text-xs font-medium">Name</span>
      <input
        class="w-full border bg-elevated px-3 py-2 text-xs outline-none focus:border-primary"
        placeholder="My MLX server"
        bind:value={name}
      />
    </label>

    <div class="grid grid-cols-[1fr_7rem] gap-3">
      <label class="block">
        <span class="mb-1 block text-xs font-medium">Host</span>
        <input
          class="w-full border bg-elevated px-3 py-2 text-xs outline-none focus:border-primary"
          bind:value={host}
        />
      </label>
      <label class="block">
        <span class="mb-1 block text-xs font-medium">Port</span>
        <input
          class="w-full border bg-elevated px-3 py-2 text-xs outline-none focus:border-primary"
          inputmode="numeric"
          bind:value={port}
        />
      </label>
    </div>

    <label class="block">
      <span class="mb-1 block text-xs font-medium">Model</span>
      <input
        class="w-full border bg-elevated px-3 py-2 text-xs outline-none focus:border-primary"
        placeholder={runtime === 'mlx' ? 'mlx-community/Qwen3-4B-4bit' : 'MyModel.mlpackage'}
        bind:value={model}
      />
    </label>

    <p class="text-xs text-dimmed">
      This server is started by your own tooling. The app registers where it listens.
    </p>
  </form>

  {#snippet footer()}
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        class="h-9 border px-4 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        type="submit"
        form="local-ai-endpoint"
        data-modal-primary
        class="flex h-9 items-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
      >
        {editing ? 'Save server' : 'Add server'}
      </button>
    </div>
  {/snippet}
</Modal>
