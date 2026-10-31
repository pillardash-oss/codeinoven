<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioCircle from '@pdslng/cio-icon/CioCircle.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import SettingsEntry from '../../shared/SettingsEntry.svelte'
  import SettingsStatusBadge from '../../shared/SettingsStatusBadge.svelte'
  import type { MenuItem } from '../../shared/ThreadDropdown.svelte'
  import ThreadDropdown from '../../shared/ThreadDropdown.svelte'
  import ConfirmDialog from '../../ui/ConfirmDialog.svelte'
  import LocalAiBrewPanel from './LocalAiBrewPanel.svelte'
  import type { BrewJob } from './local-ai-controller.svelte'
  import type { LlamaCppRuntimeStatus } from '$shared/llama-cpp'

  interface Props {
    runtime: LlamaCppRuntimeStatus | null
    detecting: boolean
    detectError: string
    onRefresh: () => void
    /** Called after an install, update, or uninstall finishes, so the row re-reads the machine. */
    onChanged: () => void
  }

  let { runtime, detecting, detectError, onRefresh, onChanged }: Props = $props()

  let job = $state<BrewJob | null>(null)
  let panelMinimized = $state(false)
  let jobExitCode = $state<number | null>(null)
  let jobCancelled = $state(false)
  let jobStopping = $state(false)
  let copied = $state(false)
  let pendingUninstall = $state(false)

  const installed = $derived(runtime?.installed ?? false)
  const canManage = $derived(Boolean(runtime?.installerPath))
  const updateAvailable = $derived(Boolean(runtime?.updateAvailable))

  const badge = $derived.by(() => {
    if (detecting && !runtime) {
      return {
        Icon: CioSpinner,
        label: 'Checking…',
        classes: 'border-info/30 bg-info/10 text-info',
        spin: true
      }
    }
    if (installed) {
      return {
        Icon: CioCheckCircle,
        label: 'Installed · Native',
        classes: 'border-success/30 bg-success/10 text-success',
        spin: false
      }
    }
    return {
      Icon: CioCircle,
      label: 'Not installed',
      classes: 'border-border bg-raised text-muted',
      spin: false
    }
  })

  function runJob(kind: BrewJob['kind'], args: string[]): void {
    if (!runtime?.installerPath) return
    jobExitCode = null
    jobCancelled = false
    jobStopping = false
    panelMinimized = false
    job = {
      kind,
      terminalId: `local-ai-brew-${kind}-${Date.now()}`,
      command: runtime.installerPath,
      args
    }
  }

  function stopJob(): void {
    if (!job) return
    jobStopping = true
    // A run the user stopped is not a failure, so the panel says "Stopped".
    jobCancelled = true
    void invoke('pty:destroy', job.terminalId)
  }

  function handleJobExit(exitCode: number): void {
    jobExitCode = exitCode
    jobStopping = false
    // The binary on disk changed, so the version and update answer are read again.
    onChanged()
  }

  function closePanel(): void {
    job = null
    jobExitCode = null
  }

  async function copyPath(): Promise<void> {
    if (!runtime?.path) return
    await invoke('clipboard:writeText', runtime.path)
    copied = true
    setTimeout(() => (copied = false), 1_500)
  }

  const menuItems = $derived.by<MenuItem[]>(() => {
    const items: MenuItem[] = [
      {
        label: 'Check again',
        icon: CioRefresh,
        disabled: detecting,
        onClick: onRefresh
      }
    ]
    if (installed && canManage) {
      items.push(
        { label: 'uninstall-divider', divider: true },
        {
          label: 'Uninstall',
          icon: CioTrash,
          danger: true,
          disabled: job !== null && jobExitCode === null,
          onClick: () => (pendingUninstall = true)
        }
      )
    }
    return items
  })
</script>

<SettingsEntry>
  <!-- The name and the controls it acts on share one line at every width; only
       the machine details below reflow. -->
  <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
    <div class="flex min-w-0 flex-1 basis-48 items-center gap-3">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center border border-border bg-elevated"
      >
        <VendorIcon name="llama.cpp" id="llamacpp" size={20} />
      </div>
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">llama.cpp</p>
        <p class="truncate font-mono text-[0.625rem] text-dimmed">
          {runtime?.version || (installed ? 'Version unknown' : 'llama-server')}
        </p>
      </div>
    </div>

    <div class="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
      {#if !updateAvailable}
        <!-- An available update is carried by the controls themselves, so the
             row never says "update" twice. -->
        {#key badge.label}
          <SettingsStatusBadge label={badge.label} classes={badge.classes}>
            <badge.Icon size={12} class="shrink-0 {badge.spin ? 'animate-spin' : ''}" />
          </SettingsStatusBadge>
        {/key}
      {/if}

      {#if updateAvailable && canManage}
        <button
          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15 disabled:opacity-50"
          title="Update llama.cpp to {runtime?.latestVersion || 'the latest build'}"
          disabled={detecting}
          onclick={() => runJob('update', ['upgrade', 'llama.cpp'])}
        >
          {#if detecting}
            <CioSpinner size={13} class="animate-spin" />
          {:else}
            <CioDownload size={13} />
          {/if}
          {runtime?.latestVersion ? `Update to ${runtime.latestVersion}` : 'Update'}
        </button>
      {:else if !installed && canManage}
        <button
          class="flex shrink-0 items-center gap-1.5 whitespace-nowrap border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15 disabled:opacity-50"
          title="Install llama.cpp with Homebrew in an embedded terminal"
          disabled={detecting}
          onclick={() => runJob('install', ['install', 'llama.cpp'])}
        >
          {#if detecting}
            <CioSpinner size={13} class="animate-spin" />
          {:else}
            <CioDownload size={13} />
          {/if}
          Install
        </button>
      {/if}

      <ThreadDropdown items={menuItems} title="llama.cpp actions" ariaLabel="llama.cpp actions" />
    </div>
  </div>

  <div class="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 @2xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
    <div class="min-w-0">
      <p class="truncate text-[0.625rem] font-medium uppercase tracking-wide text-dimmed">Path</p>
      <div class="mt-0.5 flex items-center gap-1.5">
        <span class="min-w-0 truncate font-mono text-xs text-muted" title={runtime?.path}>
          {runtime?.path ||
            (detectError ? detectError : installed ? 'Not available' : 'Not found on PATH')}
        </span>
        {#if runtime?.path}
          <button
            type="button"
            class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Copy path"
            aria-label="Copy llama-server path"
            onclick={() => void copyPath()}
          >
            {#if copied}
              <CioCheckCircle size={11} class="text-success" />
            {:else}
              <CioCopy size={11} />
            {/if}
          </button>
        {/if}
      </div>
    </div>

    <div class="min-w-0">
      <p class="truncate text-[0.625rem] font-medium uppercase tracking-wide text-dimmed">
        Installer
      </p>
      <p class="mt-0.5 truncate text-xs text-muted">
        {runtime?.installer === 'homebrew'
          ? 'Homebrew'
          : installed
            ? 'Managed outside the app'
            : 'None detected'}
      </p>
    </div>
  </div>

  {#if runtime && !installed && !canManage}
    <p class="mt-3 border-t border-border pt-3 text-xs leading-relaxed text-dimmed">
      Automatic install runs through Homebrew on macOS only. Install llama.cpp from
      <span class="font-mono">ggml-org/llama.cpp</span> releases, make
      <span class="font-mono">llama-server</span> available on PATH, then check again.
    </p>
  {/if}
</SettingsEntry>

{#if job}
  <LocalAiBrewPanel
    {job}
    minimized={panelMinimized}
    {jobExitCode}
    {jobCancelled}
    {jobStopping}
    onMinimize={() => (panelMinimized = true)}
    onExpand={() => (panelMinimized = false)}
    onClose={closePanel}
    onStop={stopJob}
    onExit={handleJobExit}
  />
{/if}

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
    This runs <span class="font-mono">brew uninstall llama.cpp</span> in the docked terminal. Until it
    is installed again, no local server can start.
  </p>
</ConfirmDialog>
