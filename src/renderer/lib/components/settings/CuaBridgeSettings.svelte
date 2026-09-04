<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    CodeXml,
    Download,
    ExternalLink,
    Loader2,
    RefreshCw,
    ShieldCheck,
    SquareTerminal
  } from '@lucide/svelte'
  import type { CuaBridgeStatus, CuaInstallationSource } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import { publicAssetUrl } from '$lib/static-assets'
  import Switch from '../ui/Switch.svelte'

  const cuaLogoUrl = publicAssetUrl('assets/cua-logo.svg')

  let status = $state<CuaBridgeStatus | null>(null)
  let loading = $state(true)
  let saving = $state(false)
  let error = $state('')
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
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Cua Driver could not be inspected.'
    } finally {
      loading = false
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    saving = true
    error = ''
    try {
      status = await invoke('computerUse:setCuaEnabled', enabled)
    } catch (saveError) {
      error =
        saveError instanceof Error ? saveError.message : 'The Cua bridge could not be updated.'
    } finally {
      saving = false
    }
  }

  async function openExternal(url: string): Promise<void> {
    try {
      await invoke('shell:openExternal', url)
    } catch (openError) {
      error = openError instanceof Error ? openError.message : 'The link could not be opened.'
    }
  }

  function openStatusUrl(
    key: 'installUrl' | 'documentationUrl' | 'updateUrl' | 'permissionsUrl' | 'repositoryUrl'
  ): void {
    const currentStatus = status
    if (currentStatus) void openExternal(currentStatus[key])
  }

  onMount(() => {
    void loadStatus()
  })
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
          <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed">Permissions</p>
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
          <code>brew upgrade</code> workflow; use Cua's updater below so the driver and supporting files
          stay together.
        </p>
      {/if}

      {#if status.updateCommand}
        <div class="mt-4 border-t pt-4">
          <div class="flex items-start gap-2">
            <SquareTerminal size={15} class="mt-0.5 shrink-0 text-muted" />
            <div>
              <p class="text-xs font-semibold">Update the installed copy</p>
              <p class="mt-1 text-[0.6875rem] leading-relaxed text-muted">
                Run this exact command in a terminal. It uses Cua's supported updater and updates
                the app and CLI together.
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

      {#if !status.compatible}
        <p class="mt-4 rounded-lg bg-warning/10 px-3 py-2 text-xs leading-relaxed text-warning">
          Downloading or extracting a newer archive does not install it. Complete the operating
          system steps below, replace the old installation, then refresh this page.
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
