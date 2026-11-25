<script lang="ts">
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioCable from '@pdslng/cio-icon/CioCable.svelte'
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioShieldCheck from '@pdslng/cio-icon/CioShieldCheck.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
  import { toast } from 'svelte-sonner'
  import Modal from '../ui/Modal.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText } from '$lib/copy-text'
  import type { OvenAgentPreview, OvenConnectionStatus } from '$shared/ovens'
  import StatusPill from '../ui/StatusPill.svelte'

  interface Props {
    open: boolean
    onClose: () => void
    /** Called after a machine is registered so the Ovens list can refresh. */
    onRegistered: (ovenId: string) => void
  }

  let { open, onClose, onRegistered }: Props = $props()

  /** The one command that prepares a machine; the pasted code carries the rest. */
  const START_COMMAND = 'npx @pdslng/cio-oven start'

  /**
   * npx is not a package to install: it ships with Node.js. A machine without
   * Node gets nvm first, then the latest Node, which brings npx with it per user.
   */
  const UNIX_NODE_INSTALL = [
    'curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.41.0/install.sh | bash',
    'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"',
    'nvm install node && nvm alias default node'
  ].join('\n')

  /** The same install on Windows, where nvm is a winget package and no shell sourcing is needed. */
  const WINDOWS_NODE_INSTALL = [
    'winget install CoreyButler.NVMforWindows',
    '# reopen the terminal so nvm is on PATH, then',
    'nvm install latest',
    'nvm use latest'
  ].join('\n')

  let code = $state('')
  let preview = $state<OvenAgentPreview | null>(null)
  let previewing = $state(false)
  let registering = $state(false)
  let copying = $state(false)
  /** An SSH port the user names for the machine, kept out of the command when empty. */
  let commandPort = $state('')
  /** The command the user runs, with their SSH port named when they set one. */
  const startCommand = $derived(
    /^\d{1,5}$/u.test(commandPort.trim())
      ? `${START_COMMAND} --port ${commandPort.trim()}`
      : START_COMMAND
  )
  /** The address this computer reaches the machine on, editable before saving. */
  let host = $state('')
  let port = $state(22)
  /** True while a full SSH probe is running against the machine. */
  let testing = $state(false)
  let connectionTestId: string | undefined
  /** The result of the last Test connection, cleared when the target changes. */
  let testResult = $state<OvenConnectionStatus | null>(null)
  let error = $state('')

  /**
   * Addresses a machine reports are its own view of itself. Behind NAT — an Azure,
   * AWS or GCP VM, a container, a port forward — that view only ever contains the
   * private side, which nothing outside can dial.
   */
  const PRIVATE_ADDRESS = /^(?:10\.|127\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/u

  /** Whether an address the machine offered is something this computer could dial. */
  function isReachableFromElsewhere(address: string): boolean {
    const value = address.trim()
    if (!value) return false
    // A bare label is the machine's own host name; it rarely resolves anywhere else.
    if (!value.includes('.') && !value.includes(':')) return false
    // IPv6 carries a ':'; private IPv4 is what needs catching.
    return value.includes(':') || !PRIVATE_ADDRESS.test(value)
  }

  /**
   * True when the machine reported only addresses it can see from inside, which is
   * the setup where a hands-off registration would otherwise just time out.
   */
  const onlyLocalAddresses = $derived.by(() => {
    const value = preview
    if (!value || value.addresses.length === 0) return false
    return !value.addresses.some(isReachableFromElsewhere)
  })

  function message(value: unknown): string {
    return value instanceof Error ? value.message : 'The Oven agent operation failed.'
  }

  async function copyCommand(): Promise<void> {
    if (copying) return
    copying = true
    try {
      await copyText(startCommand, 'Command copied')
    } catch (cause) {
      error = message(cause)
    } finally {
      copying = false
    }
  }

  /** Copy one of the Node install snippets, keeping its own label in the toast. */
  async function copySnippet(value: string, label: string): Promise<void> {
    try {
      await copyText(value, label)
    } catch (cause) {
      error = message(cause)
    }
  }

  function onCodeInput(value: string): void {
    cancelConnectionTest()
    code = value
    // A preview belongs to the code it was read from. Editing the code
    // invalidates it rather than letting a stale machine be registered.
    if (preview) preview = null
    testResult = null
  }

  /** Drop a stale probe result the moment its target changes. */
  function onTargetChange(): void {
    cancelConnectionTest()
    testResult = null
  }

  /**
   * Prove the endpoint before anything is saved.
   *
   * Reachability only says a socket is listening. This runs a real SSH session
   * with the identity from the code, so authentication, host trust, and the remote
   * shell are all confirmed on the host and port as typed.
   */
  async function testConnection(): Promise<void> {
    if (!preview || testing) return
    const address = host.trim()
    if (!address) {
      error = 'Enter the address or SSH alias this computer reaches the machine on.'
      return
    }
    const requestId = crypto.randomUUID()
    connectionTestId = requestId
    testing = true
    error = ''
    testResult = null
    try {
      const result = await invoke('oven:agent:test', { code, host: address, port }, requestId)
      if (connectionTestId !== requestId) return
      testResult = result
      if (testResult.state === 'connected') toast.success('Connection works')
    } catch (cause) {
      if (connectionTestId === requestId) error = message(cause)
    } finally {
      if (connectionTestId === requestId) {
        connectionTestId = undefined
        testing = false
      }
    }
  }

  async function checkCode(): Promise<void> {
    if (!code.trim() || previewing) return
    previewing = true
    error = ''
    preview = null
    try {
      const checked = await invoke('oven:agent:preview', code)
      preview = checked
      // The code carries every address the machine answers on. Show the first
      // one so the field is never empty; the user can pick another below.
      host = checked.addresses[0] ?? checked.host
      port = checked.port
    } catch (cause) {
      error = message(cause)
    } finally {
      previewing = false
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

  function cancelConnectionTest(): void {
    const requestId = connectionTestId
    connectionTestId = undefined
    testing = false
    if (requestId) void invoke('oven:cancelConnectionTest', requestId).catch(() => undefined)
  }

  function close(): void {
    cancelConnectionTest()
    code = ''
    preview = null
    host = ''
    testResult = null
    error = ''
    onClose()
  }
</script>

<Modal
  {open}
  title="Add a machine with the Oven service"
  description="Run one command on a machine, then register the code it prints."
  size="lg"
  onClose={close}
>
  {#if error}
    <p class="mb-4 flex items-start gap-2 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      <CioAttention size={14} class="mt-0.5 shrink-0" />
      <span>{error}</span>
    </p>
  {/if}

  <div class="space-y-6">
    <section class="space-y-3">
      <header class="space-y-0.5">
        <h3 class="text-sm font-medium">1. Prepare the machine</h3>
      </header>

      <div class="flex items-center gap-2">
        <code
          class="min-w-0 flex-1 truncate border bg-elevated px-3 py-2 font-mono text-xs text-foreground"
          >{startCommand}</code
        >
        <button
          type="button"
          class="flex h-8 shrink-0 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay disabled:opacity-50"
          disabled={copying}
          onclick={() => void copyCommand()}
        >
          {#if copying}<CioSpinner size={14} class="animate-spin" />{:else}<CioCopy
              size={14}
            />{/if}
          Copy
        </button>
      </div>

      <label class="flex items-center gap-2 text-xs text-muted">
        <span>SSH port on the machine</span>
        <input
          class="w-20 border bg-elevated px-2 py-1 text-foreground"
          type="text"
          inputmode="numeric"
          spellcheck="false"
          autocomplete="off"
          placeholder="22"
          aria-label="SSH port on the machine"
          bind:value={commandPort}
        />
      </label>

      <details class="group border bg-elevated/40">
        <summary
          class="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 hover:bg-overlay"
        >
          <span class="flex min-w-0 items-center gap-2">
            <CioTerminal size={14} class="shrink-0 text-muted" />
            <span class="text-xs font-medium">Install npx</span>
            <span class="truncate text-xs font-normal text-muted">Ships with Node.js</span>
          </span>
          <CioChevronDown
            size={14}
            class="shrink-0 text-muted transition-transform group-open:rotate-180"
          />
        </summary>

        <div class="space-y-3 border-t px-3 py-3">
          <p class="text-xs text-muted">
            A machine without Node.js has no npx. Install nvm, then the latest Node, which brings
            npx with it. The service needs Node.js 22 or later, so the current release is a safe
            pick.
          </p>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-medium">Linux and macOS</p>
              <button
                type="button"
                class="flex h-7 items-center gap-1 border bg-elevated px-2 text-xs text-foreground hover:bg-overlay"
                onclick={() =>
                  void copySnippet(UNIX_NODE_INSTALL, 'Linux and macOS install command copied')}
              >
                <CioCopy size={12} /> Copy
              </button>
            </div>
            <pre
              class="overflow-x-auto border bg-elevated px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground"><code
                >{UNIX_NODE_INSTALL}</code
              ></pre>
          </div>

          <div class="space-y-1.5">
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs font-medium">Windows (PowerShell)</p>
              <button
                type="button"
                class="flex h-7 items-center gap-1 border bg-elevated px-2 text-xs text-foreground hover:bg-overlay"
                onclick={() =>
                  void copySnippet(WINDOWS_NODE_INSTALL, 'Windows install command copied')}
              >
                <CioCopy size={12} /> Copy
              </button>
            </div>
            <pre
              class="overflow-x-auto border bg-elevated px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground"><code
                >{WINDOWS_NODE_INSTALL}</code
              ></pre>
          </div>
        </div>
      </details>
    </section>

    <section class="space-y-3 border-t pt-5">
      <header class="space-y-0.5">
        <h3 class="text-sm font-medium">2. Register the machine</h3>
      </header>

      <textarea
        class="h-24 w-full resize-y border bg-elevated px-3 py-2 font-mono text-xs text-foreground"
        placeholder="codeinoven-oven-agent-v1:…"
        spellcheck="false"
        aria-label="Registration code"
        value={code}
        oninput={(event) => onCodeInput(event.currentTarget.value)}></textarea>

      <button
        type="button"
        class="flex h-8 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay disabled:opacity-50"
        disabled={!code.trim() || previewing}
        onclick={() => void checkCode()}
      >
        {#if previewing}<CioSpinner size={14} class="animate-spin" />{:else}<CioShieldCheck
            size={14}
          />{/if}
        Check code
      </button>

      {#if preview}
        {@const verified = testResult?.state === 'connected'}
        <div class="space-y-3 border bg-elevated/40 p-3 text-xs">
          <div class="flex items-center gap-2">
            {#if verified}
              <CioCheckCircle size={14} class="text-success" />
            {:else}
              <CioCable size={14} class="text-muted" aria-hidden="true" />
            {/if}
            <span class="font-medium">{preview.name}</span>
            <StatusPill
              tone={verified ? 'success' : 'neutral'}
              title={verified
                ? 'This computer reached the machine'
                : 'Read from the pasted code. The machine has not been contacted yet.'}
            >
              {verified ? 'Verified' : 'From the code'}
            </StatusPill>
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
                class="w-full border bg-elevated px-3 py-2 text-foreground"
                type="text"
                spellcheck="false"
                autocomplete="off"
                bind:value={host}
                oninput={onTargetChange}
                placeholder="192.168.64.10 or an SSH alias"
              />
            </label>
            <label class="space-y-1">
              <span class="text-muted">SSH port</span>
              <input
                class="w-full border bg-elevated px-3 py-2 text-foreground"
                type="number"
                min="1"
                max="65535"
                bind:value={port}
                oninput={onTargetChange}
              />
            </label>
          </div>

          {#if testResult?.state === 'connected'}
            <p class="px-2 py-1 bg-success/10 text-success" role="status">
              Connection works: SSH, the key, and the remote shell all answered on {host}:{port}{testResult.specs
                ? ` (${testResult.specs.hostname})`
                : ''}{preview.serviceCurrent
                ? ', and the machine runs the same service as this app'
                : ''}.
            </p>
          {:else if testResult}
            <p class="px-2 py-1 bg-danger/10 text-danger" role="alert">
              {testResult.error ?? 'The connection failed.'}
            </p>
          {/if}

          {#if onlyLocalAddresses}
            <p
              class={'px-2 py-1 ' +
                (testResult
                  ? 'bg-warning/10 text-warning'
                  : 'border-l-2 border-warning pl-2 text-muted')}
              role="status"
            >
              <span class="font-medium">This machine only knows local addresses.</span>
              Behind NAT — a cloud VM, a container, a port forward — it cannot see the address you reach
              it on. Type that address above, and this is the only field you have to fill in; everything
              else stays hands-off.
            </p>
          {/if}

          {#if preview.addresses.length > 1}
            <div class="flex flex-wrap gap-1.5">
              {#each preview.addresses as address (address)}
                <button
                  type="button"
                  class="border px-2 py-1 font-mono transition-colors {host === address
                    ? 'border-primary bg-primary/10 text-foreground'
                    : 'bg-elevated text-muted hover:text-foreground'}"
                  aria-pressed={host === address}
                  title={`Use ${address}`}
                  onclick={() => {
                    host = address
                    onTargetChange()
                  }}
                >
                  {address}
                </button>
              {/each}
            </div>
          {/if}

          <p class="text-muted">
            The machine reports the addresses it answers on. Pick the one this computer reaches; its
            host name (<span class="text-foreground">{preview.hostname}</span>) is only a fallback,
            since it often does not resolve here.
          </p>

          {#if !preview.serviceCurrent}
            <p class="text-warning">
              The machine runs a different service. Register it, then update the Oven service from
              its row.
            </p>
          {/if}
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
    <!--
      The buttons stay direct children of the footer on purpose: the shell sends a
      leading dismiss action to the far left with `mr-auto`, which only reaches a
      direct child. Wrapping them in a row put Close back on the right.
    -->
    <button
      type="button"
      data-modal-dismiss
      class="h-8 border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay"
      onclick={close}>Close</button
    >
    {#if preview}
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium text-foreground hover:bg-overlay disabled:opacity-50"
        disabled={testing}
        onclick={() => void testConnection()}
      >
        {#if testing}<CioSpinner size={14} class="animate-spin" />{:else}<CioCable size={14} />{/if}
        Test connection
      </button>
      <button
        type="button"
        class="flex h-8 items-center gap-1.5 bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
        disabled={registering || testing}
        onclick={() => void register()}
      >
        {#if registering}<CioSpinner size={14} class="animate-spin" />{/if} Register Oven
      </button>
    {/if}
  {/snippet}
</Modal>
