<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import SettingsEntry from '../../shared/SettingsEntry.svelte'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import Modal from '../../ui/Modal.svelte'
  import ProviderLoginTerminal from '../../providers/ProviderLoginTerminal.svelte'
  import type { LlamaCppRuntimeStatus } from '$shared/llama-cpp'

  interface Props {
    runtime: LlamaCppRuntimeStatus | null
    detecting: boolean
    detectError: string
    onRefresh: () => void
  }

  let { runtime, detecting, detectError, onRefresh }: Props = $props()

  /** The Homebrew job currently running in the embedded terminal, if any. */
  let job = $state<{ kind: 'install' | 'update' | 'uninstall'; args: string[] } | null>(null)
  let jobTerminalId = $state('')
  let jobOpen = $state(false)
  let pendingUninstall = $state(false)

  const installed = $derived(runtime?.installed ?? false)
  const canManage = $derived(Boolean(runtime?.installerPath))

  function runJob(kind: 'install' | 'update' | 'uninstall', args: string[]): void {
    job = { kind, args }
    jobTerminalId = `llama-cpp-brew-${kind}-${Date.now()}`
    jobOpen = true
  }

  function jobTitle(): string {
    if (job?.kind === 'install') return 'Installing llama.cpp'
    if (job?.kind === 'update') return 'Updating llama.cpp'
    return 'Uninstalling llama.cpp'
  }

  function finishJob(): void {
    // The binary on disk changed, so the version and path are read again.
    onRefresh()
  }

  function closeJob(): void {
    jobOpen = false
    job = null
  }
</script>

<SettingsEntry>
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div class="flex min-w-0 gap-3">
      <div class="mt-0.5 text-dimmed">
        <CioServer size={18} />
      </div>
      <div class="min-w-0">
        <p class="text-sm font-semibold">llama-server</p>
        {#if detecting && !runtime}
          <p class="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
            <CioSpinner size={12} class="animate-spin" />
            Looking for the binary
          </p>
        {:else if runtime?.installed}
          <p class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span class="flex items-center gap-1 text-success">
              <CioCheckCircle size={12} />
              {runtime.version || 'Installed'}
            </span>
            <span class="truncate font-mono text-dimmed" title={runtime.path}>{runtime.path}</span>
          </p>
        {:else}
          <p class="mt-0.5 text-xs text-warning">Not installed</p>
        {/if}
        <p class="mt-1 max-w-xl text-xs leading-relaxed text-dimmed">
          {detectError || runtime?.detail || 'Checking how llama.cpp is available on this machine.'}
        </p>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-2">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center border text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
        title="Check again"
        aria-label="Check again for the llama-server binary"
        onclick={onRefresh}
        disabled={detecting}
      >
        <CioRefresh size={14} class={detecting ? 'animate-spin' : ''} />
      </button>

      {#if installed && canManage}
        <button
          type="button"
          class="border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
          onclick={() => runJob('update', ['upgrade', 'llama.cpp'])}
        >
          Update
        </button>
      {/if}

      {#if installed && canManage}
        <button
          type="button"
          class="flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium text-danger transition-colors hover:bg-danger/10"
          onclick={() => (pendingUninstall = true)}
        >
          <CioTrash size={13} />
          Uninstall
        </button>
      {:else if !installed && canManage}
        <button
          type="button"
          class="flex items-center gap-1.5 border bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-opacity disabled:opacity-50"
          onclick={() => runJob('install', ['install', 'llama.cpp'])}
          disabled={detecting}
        >
          <CioDownload size={13} />
          Install
        </button>
      {/if}
    </div>
  </div>

  {#if !installed && runtime && !canManage}
    <p class="mt-3 border-t pt-3 text-xs leading-relaxed text-dimmed">
      Automatic install runs through Homebrew on macOS only. Install llama.cpp from
      <span class="font-mono">ggml-org/llama.cpp</span> releases, then make
      <span class="font-mono">llama-server</span> available on PATH and check again.
    </p>
  {/if}

  {#if runtime?.installerPath}
    <p class="mt-3 flex items-center gap-1.5 border-t pt-3 text-xs text-dimmed">
      <CioTerminal size={12} class="shrink-0" />
      Install, update, and uninstall run in an embedded terminal with
      <span class="font-mono">{runtime.installerPath}</span>.
    </p>
  {/if}
</SettingsEntry>

<Modal open={jobOpen} title={jobTitle()} onClose={closeJob} size="lg">
  <div class="h-[22rem] w-full border bg-app">
    {#if job && runtime?.installerPath}
      <ProviderLoginTerminal
        terminalId={jobTerminalId}
        command={runtime.installerPath}
        args={job.args}
        startingLabel="Starting Homebrew"
        onExit={() => finishJob()}
      />
    {/if}
  </div>
</Modal>

<ConfirmDialog
  open={pendingUninstall}
  title="Uninstall llama.cpp"
  confirmLabel="Uninstall"
  variant="danger"
  note="Homebrew removes the binary from this machine. Server entries stay saved."
  onCancel={() => (pendingUninstall = false)}
  onConfirm={() => {
    pendingUninstall = false
    runJob('uninstall', ['uninstall', 'llama.cpp'])
  }}
>
  <p class="text-sm leading-relaxed text-muted">
    This runs <span class="font-mono">brew uninstall llama.cpp</span> in an embedded terminal. Until it
    is installed again, no local server can start.
  </p>
</ConfirmDialog>
