<script lang="ts">
  import {
    AlertTriangle,
    CheckCircle2,
    ClipboardCopy,
    FileDown,
    Loader2,
    ShieldCheck,
    Terminal
  } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import type { OvenAgentPlatform, OvenAgentPreview, OvenAgentScript } from '$shared/ovens'

  interface Props {
    open: boolean
    onClose: () => void
    /** Called after a machine is registered so the Ovens list can refresh. */
    onRegistered: (ovenId: string) => void
  }

  let { open, onClose, onRegistered }: Props = $props()

  const PLATFORMS: { id: OvenAgentPlatform; name: string }[] = [
    { id: 'linux', name: 'Linux' },
    { id: 'darwin', name: 'macOS' },
    { id: 'win32', name: 'Windows' }
  ]

  let platform = $state<OvenAgentPlatform>('linux')
  let identity = $state(true)
  let bootstrapNode = $state(true)
  let script = $state<OvenAgentScript | null>(null)
  let generating = $state(false)
  let saving = $state(false)
  let savedPath = $state('')
  let code = $state('')
  let preview = $state<OvenAgentPreview | null>(null)
  let previewing = $state(false)
  let registering = $state(false)
  let error = $state('')

  function message(value: unknown): string {
    return value instanceof Error ? value.message : 'The Oven agent operation failed.'
  }

  function invalidateScript(): void {
    script = null
    savedPath = ''
  }

  async function createScript(): Promise<void> {
    if (generating) return
    generating = true
    error = ''
    savedPath = ''
    try {
      script = await invoke('oven:agent:script', { platform, identity, bootstrapNode })
    } catch (cause) {
      script = null
      error = message(cause)
    } finally {
      generating = false
    }
  }

  async function copyScript(): Promise<void> {
    if (!script) return
    try {
      await copyText(script.content)
      toast.success('Agent installer copied')
    } catch (cause) {
      error = message(cause)
    }
  }

  async function saveScript(): Promise<void> {
    if (!script || saving) return
    saving = true
    error = ''
    try {
      const path = await invoke('dialog:saveFile', {
        suggestedName: script.filename,
        contents: script.content
      })
      if (path) {
        savedPath = path
        toast.success('Agent installer saved')
      }
    } catch (cause) {
      error = message(cause)
    } finally {
      saving = false
    }
  }

  function onCodeInput(value: string): void {
    code = value
    // A preview belongs to the code it was read from. Editing the code
    // invalidates it rather than letting a stale machine be registered.
    if (preview) preview = null
  }

  async function checkCode(): Promise<void> {
    if (!code.trim() || previewing) return
    previewing = true
    error = ''
    preview = null
    try {
      preview = await invoke('oven:agent:preview', code)
    } catch (cause) {
      error = message(cause)
    } finally {
      previewing = false
    }
  }

  async function register(): Promise<void> {
    if (!preview || registering) return
    registering = true
    error = ''
    try {
      const result = await invoke('oven:agent:register', { code })
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
    error = ''
    onClose()
  }
</script>

<Modal
  {open}
  title="Add a machine with the Oven agent"
  description="Run a self-contained installer on a machine, then register the code it prints."
  size="lg"
  onClose={close}
  claimInitialFocus={(panel) => {
    const button = panel.querySelector<HTMLElement>('[data-agent-create]')
    button?.focus()
    return Boolean(button)
  }}
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
          Create the installer, run it on the machine that will become an Oven, then register the
          code it prints. The app never needs SSH access to install it.
        </p>
      </header>

      <div class="space-y-1.5">
        <span class="text-xs font-medium">Target platform</span>
        <div class="flex flex-wrap gap-1.5" role="group" aria-label="Target platform">
          {#each PLATFORMS as option (option.id)}
            <button
              type="button"
              class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {platform ===
              option.id
                ? 'border-primary bg-primary text-on-primary'
                : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
              aria-pressed={platform === option.id}
              onclick={() => {
                platform = option.id
                invalidateScript()
              }}>{option.name}</button
            >
          {/each}
        </div>
      </div>

      <div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <span class="text-xs">
          <span class="font-medium">Provision a dedicated key</span>
          <span class="block text-muted">
            Creates an ed25519 key on the machine and includes it in the registration code.
          </span>
        </span>
        <Switch
          checked={identity}
          onchange={(value) => {
            identity = value
            invalidateScript()
          }}
          aria-label="Provision a dedicated key"
        />
      </div>

      <div class="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
        <span class="text-xs">
          <span class="font-medium">Install Node.js when missing</span>
          <span class="block text-muted">
            Uses the machine's own package manager. Off requires Node.js 22 or later already.
          </span>
        </span>
        <Switch
          checked={bootstrapNode}
          onchange={(value) => {
            bootstrapNode = value
            invalidateScript()
          }}
          aria-label="Install Node.js when missing"
        />
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-agent-create
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={generating}
          onclick={() => void createScript()}
        >
          {#if generating}<Loader2 size={14} class="animate-spin" />{:else}<Terminal
              size={14}
            />{/if}
          {script ? 'Regenerate installer' : 'Create installer'}
        </button>
        {#if script}
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay"
            onclick={() => void copyScript()}
          >
            <ClipboardCopy size={14} /> Copy script
          </button>
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay disabled:opacity-50"
            disabled={saving}
            onclick={() => void saveScript()}
          >
            {#if saving}<Loader2 size={14} class="animate-spin" />{:else}<FileDown size={14} />{/if}
            Save file
          </button>
        {/if}
      </div>

      {#if script}
        <p class="text-xs text-muted">
          {script.filename} · {script.identity ? 'dedicated key included' : 'no key included'}
          {#if savedPath}<span class="block">Saved to {savedPath}</span>{/if}
        </p>
      {/if}
    </section>

    <section class="space-y-3 border-t pt-5">
      <header class="space-y-0.5">
        <h3 class="text-sm font-medium">2. Register the machine</h3>
        <p class="text-xs text-muted">
          Paste the registration code the installer printed. Checking it first shows exactly what
          will be saved.
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
        <div class="space-y-1.5 rounded-lg border bg-elevated/40 p-3 text-xs">
          <div class="flex items-center gap-2">
            {#if preview.identityPresent}
              <CheckCircle2 size={14} class="text-success" />
              <span class="font-medium">{preview.name}</span>
            {:else}
              <AlertTriangle size={14} class="text-warning" />
              <span class="font-medium">{preview.name}</span>
            {/if}
          </div>
          <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-muted">
            <dt>Machine</dt>
            <dd class="truncate text-foreground">{preview.host}</dd>
            <dt>SSH</dt>
            <dd class="truncate text-foreground">{preview.user}@{preview.host}:{preview.port}</dd>
            <dt>Platform</dt>
            <dd class="text-foreground">{preview.platform} · {preview.architecture}</dd>
            <dt>Node.js</dt>
            <dd class="text-foreground">{preview.nodeVersion}</dd>
            {#if preview.identityFingerprint}
              <dt>Key</dt>
              <dd class="break-all text-foreground">{preview.identityFingerprint}</dd>
            {/if}
          </dl>
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
