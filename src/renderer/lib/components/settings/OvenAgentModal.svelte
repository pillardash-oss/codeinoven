<script lang="ts">
  import { AlertTriangle, CheckCircle2, ClipboardCopy, Loader2, ShieldCheck } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import Modal from '../ui/Modal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import type { OvenAgentPreview } from '$shared/ovens'

  interface Props {
    open: boolean
    onClose: () => void
    /** Called after a machine is registered so the Ovens list can refresh. */
    onRegistered: (ovenId: string) => void
  }

  let { open, onClose, onRegistered }: Props = $props()

  /** The one command that prepares a machine; the pasted code carries the rest. */
  const START_COMMAND = 'npx cio-oven start'

  let code = $state('')
  let preview = $state<OvenAgentPreview | null>(null)
  let previewing = $state(false)
  let registering = $state(false)
  let copying = $state(false)
  /** The address this computer reaches the machine on, editable before saving. */
  let host = $state('')
  let port = $state(22)
  /** True while the machine's own candidates are being dialed. */
  let detecting = $state(false)
  /** The candidate that answered, when one did. */
  let detected = $state<string | null>(null)
  let error = $state('')

  function message(value: unknown): string {
    return value instanceof Error ? value.message : 'The Oven agent operation failed.'
  }

  async function copyCommand(): Promise<void> {
    if (copying) return
    copying = true
    try {
      await copyText(START_COMMAND)
      toast.success('Command copied')
    } catch (cause) {
      error = message(cause)
    } finally {
      copying = false
    }
  }

  function onCodeInput(value: string): void {
    code = value
    // A preview belongs to the code it was read from. Editing the code
    // invalidates it rather than letting a stale machine be registered.
    if (preview) preview = null
    detected = null
  }

  async function checkCode(): Promise<void> {
    if (!code.trim() || previewing) return
    previewing = true
    error = ''
    preview = null
    detected = null
    try {
      const checked = await invoke('oven:agent:preview', code)
      preview = checked
      // The code carries every address the machine answers on. Show the first
      // one immediately so the field is never empty, then replace it with the
      // one that actually answers here.
      host = checked.addresses[0] ?? checked.host
      port = checked.port
      previewing = false
      void detectAddress()
    } catch (cause) {
      error = message(cause)
      previewing = false
    }
  }

  /**
   * Dial the machine's own candidates and keep the one that answers.
   *
   * A machine reports its interface addresses but cannot know which one this
   * computer can reach, so the choice is made here. When nothing answers, the
   * field keeps the machine's own first choice and the user can still edit it.
   */
  async function detectAddress(): Promise<void> {
    if (detecting) return
    detecting = true
    try {
      const reachable = await invoke('oven:agent:reachable', code)
      if (reachable) {
        detected = reachable
        host = reachable
      }
    } catch {
      // A probe that cannot run is not a registration failure: the field already
      // holds a usable candidate from the machine itself.
    } finally {
      detecting = false
    }
  }

  async function register(): Promise<void> {
    if (!preview || registering) return
    const address = host.trim()
    if (!address) {
      error = 'Enter the address or SSH alias this computer reaches the machine on.'
      return
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      error = 'SSH port must be between 1 and 65535.'
      return
    }
    registering = true
    error = ''
    try {
      const result = await invoke('oven:agent:register', { code, host: address, port })
      toast.success(`${result.oven.name} registered`)
      onRegistered(result.oven.id)
      close()
    } catch (cause) {
      error = message(cause)
    } finally {
      registering = false
    }
  }

  function close(): void {
    code = ''
    preview = null
    host = ''
    detected = null
    detecting = false
    error = ''
    onClose()
  }
</script>

<Modal
  {open}
  title="Add a machine with the Oven agent"
  description="Run one command on a machine, then register the code it prints."
  size="lg"
  onClose={close}
>
  {#if error}
    <p
      class="mb-4 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger"
      role="alert"
    >
      <AlertTriangle size={14} class="mt-0.5 shrink-0" />
      <span>{error}</span>
    </p>
  {/if}

  <div class="space-y-6">
    <section class="space-y-3">
      <header class="space-y-0.5">
        <h3 class="text-sm font-medium">1. Prepare the machine</h3>
        <p class="text-xs text-muted">
          Run this command on the machine that will become an Oven. It installs the durable service,
          starts it in the background, and prints the code you register below. The app never needs
          SSH access to install it.
        </p>
      </header>

      <div class="flex items-center gap-2">
        <code
          class="min-w-0 flex-1 truncate rounded-lg border bg-elevated px-3 py-2 font-mono text-xs text-foreground"
          >{START_COMMAND}</code
        >
        <button
          type="button"
          class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay disabled:opacity-50"
          disabled={copying}
          onclick={() => void copyCommand()}
        >
          {#if copying}<Loader2 size={14} class="animate-spin" />{:else}<ClipboardCopy
              size={14}
            />{/if}
          Copy
        </button>
      </div>

      <p class="text-xs text-muted">
        The machine needs Node.js 22 or later already installed. The command asks for the Oven name,
        the SSH port this computer connects on, and whether to provision a dedicated key.
      </p>
    </section>

    <section class="space-y-3 border-t pt-5">
      <header class="space-y-0.5">
        <h3 class="text-sm font-medium">2. Register the machine</h3>
        <p class="text-xs text-muted">
          Paste the registration code the command printed. Checking it first shows exactly what will
          be saved.
        </p>
      </header>

      <textarea
        class="h-24 w-full resize-y rounded-lg border bg-elevated px-3 py-2 font-mono text-xs text-foreground"
        placeholder="codeinoven-oven-agent-v1:…"
        spellcheck="false"
        aria-label="Registration code"
        value={code}
        oninput={(event) => onCodeInput(event.currentTarget.value)}></textarea>

      <button
        type="button"
        class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay disabled:opacity-50"
        disabled={!code.trim() || previewing}
        onclick={() => void checkCode()}
      >
        {#if previewing}<Loader2 size={14} class="animate-spin" />{:else}<ShieldCheck
            size={14}
          />{/if}
        Check code
      </button>

      {#if preview}
        <div class="space-y-3 rounded-lg border bg-elevated/40 p-3 text-xs">
          <div class="flex items-center gap-2">
            {#if preview.identityPresent}
              <CheckCircle2 size={14} class="text-success" />
            {:else}
              <AlertTriangle size={14} class="text-warning" />
            {/if}
            <span class="font-medium">{preview.name}</span>
          </div>

          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-muted">
            <dt>Machine</dt>
            <dd class="truncate text-foreground">{preview.hostname}</dd>
            <dt>SSH user</dt>
            <dd class="truncate text-foreground">{preview.user}</dd>
            <dt>Platform</dt>
            <dd class="text-foreground">{preview.platform} · {preview.architecture}</dd>
            <dt>Node.js</dt>
            <dd class="text-foreground">{preview.nodeVersion}</dd>
            {#if preview.identityFingerprint}
              <dt>Key</dt>
              <dd class="break-all text-foreground">{preview.identityFingerprint}</dd>
            {/if}
          </dl>

          <div class="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <label class="space-y-1">
              <span class="text-muted">Address this computer uses</span>
              <input
                class="w-full rounded-lg border bg-elevated px-3 py-2 text-foreground"
                type="text"
                spellcheck="false"
                autocomplete="off"
                bind:value={host}
                placeholder="192.168.64.10 or an SSH alias"
              />
            </label>
            <label class="space-y-1">
              <span class="text-muted">SSH port</span>
              <input
                class="w-full rounded-lg border bg-elevated px-3 py-2 text-foreground"
                type="number"
                min="1"
                max="65535"
                bind:value={port}
              />
            </label>
          </div>

          {#if detecting}
            <span class="flex items-center gap-1.5 text-muted" role="status">
              <Loader2 size={12} class="animate-spin" /> Reaching the machine on the addresses it reported…
            </span>
          {:else if detected}
            <span class="flex items-center gap-1.5 text-success">
              <CheckCircle2 size={12} />
              {detected} answered, so that is where the Oven will connect.
            </span>
          {:else}
            <span class="text-warning">
              None of the machine's own addresses answered from this computer. Pick one below, or
              enter the address you reach it on.
            </span>
          {/if}

          {#if preview.addresses.length > 1}
            <div class="flex flex-wrap gap-1.5">
              {#each preview.addresses as address (address)}
                <button
                  type="button"
                  class="rounded-md border px-2 py-1 font-mono transition-colors {host === address
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'bg-elevated text-muted hover:text-foreground'}"
                  aria-pressed={host === address}
                  title={`Use ${address}`}
                  onclick={() => (host = address)}
                >
                  {address}
                </button>
              {/each}
            </div>
          {/if}

          <p class="text-muted">
            The machine reports every address it answers on. This computer dials them and uses the
            first that connects; the machine's host name (<span class="text-foreground"
              >{preview.hostname}</span
            >) is only a fallback, since it often does not resolve here.
          </p>

          <p class={preview.serviceCurrent ? 'text-success' : 'text-warning'}>
            {preview.serviceCurrent
              ? 'The machine runs the same service as this app.'
              : 'The machine runs a different service. Register it, then update the Oven service from its row.'}
          </p>
          {#if !preview.identityPresent}
            <p class="text-warning">
              No key was included. The Oven is saved against your SSH agent; edit it if it needs
              another identity.
            </p>
          {/if}
        </div>
      {/if}
    </section>
  </div>

  {#snippet footer()}
    <div class="flex items-center justify-end gap-2">
      <button
        type="button"
        data-modal-dismiss
        class="h-8 rounded-lg border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay"
        onclick={close}>Close</button
      >
      {#if preview}
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={registering}
          onclick={() => void register()}
        >
          {#if registering}<Loader2 size={14} class="animate-spin" />{/if} Register Oven
        </button>
      {/if}
    </div>
  {/snippet}
</Modal>
