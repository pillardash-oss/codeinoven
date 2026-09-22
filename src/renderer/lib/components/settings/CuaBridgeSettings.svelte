<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    AlertTriangle,
    ArrowUpCircle,
    CheckCircle2,
    CodeXml,
    Download,
    ExternalLink,
    Loader2,
    RefreshCw,
    ShieldCheck,
    SquareTerminal
  } from '@lucide/svelte'
  import type {
    CuaBridgeStatus,
    CuaInstallationSource,
    CuaUpdateCheck,
    CuaUpdateProgress
  } from '$shared/types'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { publicAssetUrl } from '$lib/static-assets'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import DownloadProgress from '../ui/DownloadProgress.svelte'
  import Switch from '../ui/Switch.svelte'

  const cuaLogoUrl = publicAssetUrl('assets/cua-logo.svg')

  let status = $state<CuaBridgeStatus | null>(null)
  let loading = $state(true)
  let saving = $state(false)
  let error = $state('')
  let update = $state<CuaUpdateCheck | null>(null)
  let updateProgress = $state<CuaUpdateProgress | null>(null)
  let updateError = $state('')
  let checkingUpdate = $state(false)
  let confirmingUpdate = $state(false)
  let updating = $derived(updateProgress?.state === 'updating')
  let updatedVersion = $derived(updateProgress?.version ?? status?.version ?? '')
  let selectedInstallation = $derived(
    status?.installations.find((installation) => installation.selected) ?? null
  )
  let otherInstallations = $derived(
    status?.installations.filter((installation) => !installation.selected) ?? []
  )

  let statusLabel = $derived.by(() => {
    if (!status?.installed) return 'Not installed'
    if (!status.compatible) return 'Version mismatch'
    if (!status.mcpAvailable) return 'MCP unavailable'
    if (status.permissionStatus === 'missing') return 'Permissions required'
    if (status.enabled) return 'Connected'
    return 'Ready to enable'
  })

  let setupSteps = $derived.by(() => {
    if (status?.platform === 'macos') {
      return [
        `Download and extract ${status.downloadName ?? `the Cua ${status.targetVersion} archive`}.`,
        'Move CuaDriver.app into /Applications and replace the older copy. Do not install only the standalone cua-driver binary.',
        'Return here and refresh. CodeInOven will verify the app and its linked CLI together.',
        'Grant Accessibility and Screen Recording after the supported version is detected.'
      ]
    }
    if (status?.platform === 'windows') {
      return [
        `Download and extract ${status.downloadName ?? `the Cua ${status.targetVersion} archive`}.`,
        'Follow the setup guide to install Cua Driver for the current Windows user and add it to PATH.',
        'Run cua-driver serve in the interactive desktop session, then refresh this page.'
      ]
    }
    return [
      `Download and extract ${status?.downloadName ?? `the Cua ${status?.targetVersion ?? 'supported'} archive`}.`,
      'Follow the setup guide to install the binary for the current user and add it to PATH.',
      'Confirm AT-SPI and the display server, run cua-driver serve, then refresh this page.'
    ]
  })

  function sourceLabel(source: CuaInstallationSource): string {
    if (source === 'application') return 'CuaDriver.app'
    if (source === 'canonical') return 'Official user install'
    if (source === 'homebrew') return 'Homebrew path'
    if (source === 'environment') return 'CUA_DRIVER_PATH override'
    return 'PATH installation'
  }

  async function loadStatus(): Promise<void> {
    loading = true
    error = ''
    try {
      status = await invoke('computerUse:getCuaStatus')
      // Every status read asks the driver's own release check again, so the
      // update row can never describe a version that is no longer installed.
      if (status.installed) void checkForUpdates()
    } catch (loadError) {
      error = errorMessage(loadError, 'Cua Driver could not be inspected.')
    } finally {
      loading = false
    }
  }

  /**
   * Ask the driver whether Cua published a newer release.
   *
   * `skipCache` reaches GitHub instead of the driver's 20-hour on-disk answer,
   * which is what an explicit "check again" has to mean.
   */
  async function checkForUpdates(skipCache = false): Promise<void> {
    if (!status?.installed || updating) return
    checkingUpdate = true
    updateError = ''
    try {
      update = await invoke('computerUse:checkCuaUpdate', skipCache)
      if (updateProgress?.state === 'failed') updateProgress = null
    } catch (checkError) {
      updateError = errorMessage(checkError, 'Cua Driver updates could not be checked.')
    } finally {
      checkingUpdate = false
    }
  }

  async function applyUpdate(): Promise<void> {
    confirmingUpdate = false
    updateError = ''
    updateProgress = { state: 'updating', detail: "Starting Cua's installer" }
    try {
      status = await invoke('computerUse:updateCua')
      update = await invoke('computerUse:checkCuaUpdate', true)
    } catch (updateFailure) {
      updateError = errorMessage(updateFailure, 'Cua Driver could not be updated.')
    }
  }

  function openUpdateReleaseNotes(): void {
    const url = update?.releaseNotesUrl
    if (url) void openExternal(url)
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    saving = true
    error = ''
    try {
      status = await invoke('computerUse:setCuaEnabled', enabled)
    } catch (saveError) {
      error = errorMessage(saveError, 'The Cua bridge could not be updated.')
    } finally {
      saving = false
    }
  }

  async function openExternal(url: string): Promise<void> {
    try {
      await invoke('shell:openExternal', url)
    } catch (openError) {
      error = errorMessage(openError, 'The link could not be opened.')
    }
  }

  function errorMessage(cause: unknown, fallback: string): string {
    return cause instanceof Error && cause.message ? cause.message : fallback
  }

  function openStatusUrl(
    key: 'installUrl' | 'documentationUrl' | 'updateUrl' | 'permissionsUrl' | 'repositoryUrl'
  ): void {
    const currentStatus = status
    if (currentStatus) void openExternal(currentStatus[key])
  }

  let unsubscribeUpdate: (() => void) | null = null

  onMount(() => {
    // Installer milestones for an update this window did not start (another
    // window can) still land here, so the row reflects the real run either way.
    unsubscribeUpdate = subscribe('computerUse:cuaUpdate', (progress) => {
      updateProgress = progress
    })
    void loadStatus()
  })

  onDestroy(() => unsubscribeUpdate?.())
</script>

<div class="space-y-5 p-6 pb-24">
  {#if error}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  <section class="rounded-2xl border bg-surface p-5">
    <div class="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
      <div class="flex min-w-0 items-start gap-4">
        <div
          class="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#2f80ed]"
          aria-hidden="true"
        >
          <img src={cuaLogoUrl} alt="" class="h-9 w-9" />
        </div>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="text-base font-semibold">Cua Driver</h2>
          </div>
          <p class="mt-1 max-w-2xl text-sm leading-relaxed text-muted">
            Let agents operate desktop apps with Cua Driver when a task requires computer use.
          </p>
        </div>
      </div>

      {#if loading && !status}
        <span class="flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} class="animate-spin" /> Inspecting
        </span>
      {:else if status}
        <div class="flex shrink-0 items-center gap-2">
          <span
            class="rounded-lg px-2.5 py-1 text-xs font-medium {status.enabled && status.ready
              ? 'bg-success/10 text-success'
              : status.installed && status.compatible
                ? 'bg-warning/10 text-warning'
                : 'bg-elevated text-muted'}"
          >
            {statusLabel}
          </span>
          <Switch
            checked={status.enabled}
            disabled={saving || !status.ready}
            onchange={(enabled) => void setEnabled(enabled)}
            title={status.enabled ? 'Disable the Cua bridge' : 'Enable the Cua bridge'}
            aria-label={status.enabled ? 'Disable the Cua bridge' : 'Enable the Cua bridge'}
          />
        </div>
      {/if}
    </div>

    {#if status}
      <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="rounded-xl bg-elevated px-3 py-2.5">
          <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Installed</p>
          <p class="mt-1 text-sm font-medium">{status.version ?? 'Not detected'}</p>
        </div>
        <div class="rounded-xl bg-elevated px-3 py-2.5">
          <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Supported</p>
          <p class="mt-1 text-sm font-medium">{status.supportedVersionRange}</p>
        </div>
        <div class="rounded-xl bg-elevated px-3 py-2.5">
          <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">
            Permissions
          </p>
          <p class="mt-1 text-sm font-medium">
            {status.permissionStatus === 'not_required'
              ? 'Platform managed'
              : status.permissionStatus === 'granted'
                ? 'Granted'
                : status.permissionStatus === 'missing'
                  ? 'Action required'
                  : 'Unknown'}
          </p>
        </div>
        <div class="rounded-xl bg-elevated px-3 py-2.5">
          <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Daemon</p>
          <p class="mt-1 text-sm font-medium">
            {status.daemonRunning
              ? 'Running'
              : status.platform === 'macos'
                ? 'Starts on demand'
                : 'Start required'}
          </p>
        </div>
      </div>

      {#if status.detail}
        <div
          class="mt-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <AlertTriangle size={14} class="mt-0.5 shrink-0" />
          <span>{status.detail}</span>
        </div>
      {/if}

      <div class="mt-4 flex flex-wrap gap-2">
        {#if !status.ready}
          <button
            type="button"
            class="flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
            title={status.downloadLabel}
            onclick={() => openStatusUrl('installUrl')}
          >
            <Download size={14} />
            {status.downloadLabel}
          </button>
        {/if}
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          disabled={loading}
          title="Refresh Cua Driver status"
          onclick={() => void loadStatus()}
        >
          <RefreshCw size={14} class={loading ? 'animate-spin' : ''} /> Refresh status
        </button>
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          title="Open the Cua Driver setup guide"
          onclick={() => openStatusUrl('documentationUrl')}
        >
          <ShieldCheck size={14} /> Setup guide
        </button>
        <button
          type="button"
          class="flex h-9 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          title="Open the Cua source repository"
          onclick={() => openStatusUrl('repositoryUrl')}
        >
          <CodeXml size={14} /> GitHub
        </button>
      </div>
    {/if}
  </section>

  {#if status?.installed}
    <section class="rounded-2xl border bg-surface p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 class="text-sm font-semibold">Driver updates</h2>
          <p class="mt-1 max-w-2xl text-xs leading-relaxed text-muted">
            CodeInOven updates the installed copy through Cua's own signed installer, so the app and
            the CLI always move together. Cua verifies the new bundle's signature and restores the
            previous copy when that check fails.
          </p>
        </div>
        <button
          type="button"
          class="flex h-9 shrink-0 items-center gap-2 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          disabled={checkingUpdate || updating}
          title="Check Cua releases again"
          onclick={() => void checkForUpdates(true)}
        >
          <RefreshCw size={14} class={checkingUpdate ? 'animate-spin' : ''} /> Check again
        </button>
      </div>

      {#if updateProgress?.state === 'updating'}
        <div class="mt-4">
          <DownloadProgress
            indeterminate
            label="Updating Cua Driver…"
            detail={updateProgress.detail}
            hint="Cua's installer replaces CuaDriver.app and the CLI, then stops the running daemon."
            ariaLabel="Cua Driver update progress"
          />
        </div>
      {:else if updateProgress?.state === 'installed'}
        <div
          class="mt-4 flex items-start gap-2 rounded-lg bg-success/10 px-3 py-2 text-xs text-success"
        >
          <CheckCircle2 size={14} class="mt-0.5 shrink-0" />
          <span>
            {updatedVersion
              ? `Cua Driver ${updatedVersion} is installed.`
              : 'The update is installed.'} New agent sessions pick it up; a session that is already running
            keeps the driver it started with.
          </span>
        </div>
      {:else if updateProgress?.state === 'failed' || updateError}
        <div class="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning" role="alert">
          <div class="flex items-start gap-2">
            <AlertTriangle size={14} class="mt-0.5 shrink-0" />
            <span class="whitespace-pre-line break-words">
              {updateProgress?.state === 'failed' ? updateProgress.error : updateError}
            </span>
          </div>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              class="flex h-8 items-center gap-2 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
              title="Check Cua releases again"
              onclick={() => void checkForUpdates(true)}
            >
              <RefreshCw size={13} /> Check again
            </button>
            {#if update?.updateAvailable}
              <button
                type="button"
                class="flex h-8 items-center gap-2 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
                title={`Try updating Cua Driver to ${update.latestVersion} again`}
                onclick={() => (confirmingUpdate = true)}
              >
                <ArrowUpCircle size={13} /> Try the update again
              </button>
            {/if}
          </div>
        </div>
      {:else if update?.updateAvailable}
        <div
          class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-elevated px-3 py-3"
        >
          <div>
            <p class="text-sm font-medium">Cua {update.latestVersion} is available</p>
            <p class="mt-0.5 text-[0.6875rem] text-muted">
              Installed {update.currentVersion}{update.channel
                ? ` · ${update.channel} channel`
                : ''}{update.cached ? ' · cached release check' : ''}
            </p>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button
              type="button"
              class="flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
              title={`Update Cua Driver to ${update.latestVersion}`}
              onclick={() => (confirmingUpdate = true)}
            >
              <ArrowUpCircle size={14} /> Update to {update.latestVersion}
            </button>
            {#if update.releaseNotesUrl}
              <button
                type="button"
                class="flex h-9 items-center gap-1.5 rounded-lg border bg-surface px-3 text-xs font-medium hover:bg-overlay"
                title={`Read the Cua ${update.latestVersion} release notes`}
                onclick={openUpdateReleaseNotes}
              >
                Release notes <ExternalLink size={12} />
              </button>
            {/if}
          </div>
        </div>
      {:else if checkingUpdate}
        <p class="mt-4 flex items-center gap-2 text-xs text-muted">
          <Loader2 size={14} class="animate-spin" /> Checking Cua for a newer release…
        </p>
      {:else if update}
        <p class="mt-4 text-xs text-muted">
          Cua Driver {update.currentVersion} is the newest release on the {update.channel ??
            'stable'}
          channel.
        </p>
      {/if}

      {#if status.updateCommand}
        <div class="mt-4 border-t pt-4">
          <div class="flex items-start gap-2">
            <SquareTerminal size={15} class="mt-0.5 shrink-0 text-muted" />
            <div>
              <p class="text-xs font-semibold">Prefer a terminal?</p>
              <p class="mt-1 text-[0.6875rem] leading-relaxed text-muted">
                This is the same updater CodeInOven runs for you.
              </p>
            </div>
          </div>
          <code class="mt-2 block select-all break-all rounded-lg bg-elevated px-3 py-2 text-xs">
            {status.updateCommand}
          </code>
          <button
            type="button"
            class="mt-2 flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
            title="Open Cua Driver update instructions"
            onclick={() => openStatusUrl('updateUrl')}
          >
            Read update instructions <ExternalLink size={12} />
          </button>
        </div>
      {/if}
    </section>
  {/if}

  {#if status && selectedInstallation}
    <section class="rounded-xl border bg-surface p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 class="text-sm font-semibold">Installation in use</h3>
          <p class="mt-1 text-xs text-muted">
            {sourceLabel(selectedInstallation.source)} · Cua
            {selectedInstallation.version ?? 'version unknown'}
          </p>
        </div>
        <span
          class="rounded-md bg-elevated px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
        >
          Selected by CodeInOven
        </span>
      </div>

      <code class="mt-3 block select-all break-all rounded-lg bg-elevated px-3 py-2 text-xs">
        {selectedInstallation.path}
      </code>
      {#if selectedInstallation.path !== selectedInstallation.realPath}
        <p class="mt-1.5 break-all text-[0.6875rem] text-dimmed">
          Resolves to {selectedInstallation.realPath}
        </p>
      {/if}

      {#if selectedInstallation.source === 'homebrew'}
        <p class="mt-3 text-xs leading-relaxed text-warning">
          This executable is on a Homebrew path. Cua does not document a Homebrew formula or
          <code>brew upgrade</code> workflow; use the updater above so the driver and supporting files
          stay together.
        </p>
      {/if}

      {#if !status.compatible}
        <p class="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          This copy is older than the driver contract CodeInOven targets. Use Update in the Driver
          updates card above; if that cannot run, replace the installation by hand and refresh this
          page.
        </p>
      {/if}

      {#if otherInstallations.length > 0}
        <div class="mt-4 border-t pt-4">
          <p class="text-xs font-semibold">Other copies found</p>
          <p class="mt-1 text-[0.6875rem] text-muted">
            CodeInOven prefers a compatible signed app, then the newest compatible executable.
          </p>
          <ul class="mt-2 space-y-2">
            {#each otherInstallations as installation (installation.realPath)}
              <li class="text-[0.6875rem] text-muted">
                <span class="font-medium text-foreground">
                  Cua {installation.version ?? 'version unknown'}
                </span>
                · {sourceLabel(installation.source)}
                <code class="mt-0.5 block select-all break-all text-dimmed">
                  {installation.path}
                </code>
              </li>
            {/each}
          </ul>
        </div>
      {/if}
    </section>
  {/if}

  <section class="rounded-xl border bg-surface p-4">
    <h3 class="text-sm font-semibold">Set up this computer</h3>
    <ol class="mt-3 space-y-2">
      {#each setupSteps as step, index (step)}
        <li class="flex items-start gap-2.5 text-xs leading-relaxed text-muted">
          <span
            class="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-elevated text-[0.625rem] font-semibold text-foreground"
            >{index + 1}</span
          >
          <span>{step}</span>
        </li>
      {/each}
    </ol>
    {#if status?.platform === 'macos'}
      <button
        type="button"
        class="mt-3 flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
        title="Open macOS permission instructions"
        onclick={() => openStatusUrl('permissionsUrl')}
      >
        Review macOS permissions <ExternalLink size={12} />
      </button>
    {/if}
  </section>

  <section class="rounded-xl border bg-surface p-4">
    <h3 class="text-sm font-semibold">Thread permissions</h3>
    <div class="mt-3 grid gap-3 sm:grid-cols-2">
      <div class="rounded-lg bg-elevated p-3">
        <p class="text-xs font-semibold">Auto Review</p>
        <p class="mt-1 text-[0.6875rem] leading-relaxed text-muted">
          Cua runs in standard mode. Routine desktop actions proceed; explicitly denied boundaries
          return to the thread for permission.
        </p>
      </div>
      <div class="rounded-lg bg-elevated p-3">
        <p class="text-xs font-semibold">Full Access</p>
        <p class="mt-1 text-[0.6875rem] leading-relaxed text-muted">
          Cua runs in unrestricted mode with its required acknowledgement. Platform invariants and
          managed policies still apply.
        </p>
      </div>
    </div>
  </section>
</div>

<ConfirmDialog
  open={confirmingUpdate}
  title="Update Cua Driver"
  confirmLabel={`Update to ${update?.latestVersion ?? 'the latest release'}`}
  busy={updating}
  onCancel={() => (confirmingUpdate = false)}
  onConfirm={() => void applyUpdate()}
>
  <p>
    Cua's signed installer downloads the newest release and replaces
    <code>CuaDriver.app</code> together with the <code>cua-driver</code> CLI. Cua verifies the new bundle's
    signature and restores the previous copy if that check fails.
  </p>
  <p>
    Any agent driving the desktop through Cua is interrupted while the driver restarts, and macOS
    may ask you to grant Accessibility and Screen Recording again afterwards.
  </p>
</ConfirmDialog>
