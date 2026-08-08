<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import type { SettingsSection } from '$lib/stores/renderer-recovery.svelte'
  import { updaterState } from '$lib/stores/updater.svelte'
  import type { AppConfig, AppConfigPatch, SlashCommandMode, ThemePreference } from '$shared/types'
  import type { SystemNotificationPermissionStatus } from '$shared/ipc-contract'
  import { APP_NAME, APP_SLUG, ORG_SLUG } from '$shared/brand'
  import {
    AlertCircle,
    AlertTriangle,
    ArrowLeft,
    Bell,
    BrainCircuit,
    CheckCircle2,
    Clock,
    Download,
    Globe,
    Info,
    Loader2,
    Monitor,
    Moon,
    Puzzle,
    Plug,
    RefreshCw,
    SlidersHorizontal,
    Sun,
    UsersRound
  } from '@lucide/svelte'
  import CollapsibleSidebar from '../layout/CollapsibleSidebar.svelte'
  import Switch from '../ui/Switch.svelte'
  import Modal from '../ui/Modal.svelte'
  import ProvidersView from '../providers/ProvidersView.svelte'
  import UtilitiesView from './UtilitiesView.svelte'
  import SettingsMemoryTab from '../memory/MemoryPanel.svelte'
  import AuditSettingsTab from './AuditSettingsTab.svelte'
  import RemoteSettingsTab from './RemoteSettingsTab.svelte'

  type SelectChangeEvent = Event & { currentTarget: HTMLSelectElement }
  interface Props {
    config: AppConfig
    settingsReady: boolean
    error?: string
    setPreference: (pref: ThemePreference) => void
    updateConfig: (patch: AppConfigPatch) => Promise<void>
    /** The settings section page currently on screen. */
    section: SettingsSection
    /** Navigate to another settings section page. */
    onNavigateSection: (section: SettingsSection) => void
    /** Returns to the project page. */
    onBack: () => void
  }

  let {
    config,
    settingsReady,
    error,
    setPreference,
    updateConfig,
    section,
    onNavigateSection,
    onBack
  }: Props = $props()

  let diagnosticsBusy = $state(false)
  let diagnosticsResult = $state('')
  let notificationTestBusy = $state(false)
  let notificationTestResult = $state('')
  let notificationTestFailed = $state(false)
  let notificationPermission = $state<SystemNotificationPermissionStatus | null>(null)
  let nightlyModalOpen = $state(false)
  let channelBusy = $state(false)

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onBack()
    }
  }

  const tabs: Array<{
    id: SettingsSection
    label: string
    icon: typeof SlidersHorizontal
  }> = [
    { id: 'general', label: 'General', icon: SlidersHorizontal },

    { id: 'memory', label: 'Memory', icon: BrainCircuit },
    { id: 'audits', label: 'Agents', icon: UsersRound },
    { id: 'harnesses', label: 'Harnesses', icon: Plug },
    { id: 'utilities', label: 'Utilities', icon: Puzzle },
    { id: 'remote', label: 'Remote', icon: Globe },
    { id: 'about', label: 'About', icon: Info }
  ]

  // The header mirrors the section on screen — cleared when Settings closes.
  $effect(() => {
    settingsUiState.activeTabLabel = tabs.find((tab) => tab.id === section)?.label ?? null
    return () => {
      settingsUiState.activeTabLabel = null
    }
  })

  const themeOptions = [
    { id: 'system' as const, label: 'System', icon: Monitor },
    { id: 'light' as const, label: 'Light', icon: Sun },
    { id: 'dark' as const, label: 'Dark', icon: Moon }
  ]

  const slashCommandOptions: Array<{
    id: SlashCommandMode
    label: string
    description: string
  }> = [
    {
      id: 'app',
      label: `${APP_NAME} actions`,
      description: `${APP_NAME} handles supported slash commands in the app.`
    },
    {
      id: 'passthrough',
      label: 'Harness passthrough',
      description: 'Forward slash commands to the active agent harness.'
    }
  ]

  function saveThreadLimit(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return

    const value = Number(input.value)
    if (!Number.isInteger(value) || value < 1 || value > 1000) {
      input.value = String(config.threadLimit)
      return
    }

    void updateConfig({ threadLimit: value })
  }

  function saveQuestionTimeout(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return

    const seconds = Number(input.value)
    if (!Number.isInteger(seconds) || seconds < 10 || seconds > 3600) {
      input.value = String(config.questionTimeoutMs / 1_000)
      return
    }

    void updateConfig({ questionTimeoutMs: seconds * 1_000 })
  }

  async function exportDiagnostics(): Promise<void> {
    diagnosticsBusy = true
    diagnosticsResult = ''
    try {
      const path = await invoke('diagnostics:export')
      diagnosticsResult = path ? `Saved to ${path}` : ''
    } catch (exportError) {
      diagnosticsResult =
        exportError instanceof Error ? exportError.message : 'Diagnostics export failed.'
    } finally {
      diagnosticsBusy = false
    }
  }

  async function testSystemNotification(): Promise<void> {
    notificationTestBusy = true
    notificationTestResult = ''
    notificationTestFailed = false
    try {
      const result = await invoke('notification:test')
      notificationTestResult = result.message
      notificationTestFailed = result.status !== 'shown'
      await refreshNotificationPermission()
    } catch (notificationError) {
      notificationTestFailed = true
      notificationTestResult =
        notificationError instanceof Error
          ? notificationError.message
          : 'The system notification test failed.'
    } finally {
      notificationTestBusy = false
    }
  }

  async function refreshNotificationPermission(): Promise<void> {
    try {
      notificationPermission = await invoke('notification:getPermissionStatus')
    } catch {
      notificationPermission = null
    }
  }

  function openNotificationSettings(): void {
    void invoke(
      'shell:openExternal',
      'x-apple.systempreferences:com.apple.Notifications-Settings.extension'
    )
  }

  onMount(() => {
    void refreshNotificationPermission()
  })

  const isNightlyChannel = $derived(config.updateChannel === 'nightly')

  /** Toggle ON opens the confirmation modal; only a confirmed choice persists. */
  function onNightlyToggleRequested(enabled: boolean): void {
    if (enabled) {
      nightlyModalOpen = true
    } else {
      void setChannel('stable')
    }
  }

  async function setChannel(channel: 'stable' | 'nightly'): Promise<void> {
    if (channelBusy) return
    channelBusy = true
    nightlyModalOpen = false
    try {
      await updateConfig({ updateChannel: channel })
      await updaterState.checkForUpdates()
    } catch {
      // updateConfig surfaces errors in the general settings header.
    } finally {
      channelBusy = false
    }
  }
</script>

<svelte:window onkeydown={escHandler} />

<div class="flex h-full">
  <!-- Settings navigation — the shared sidebar, pinned so it can never be hidden here -->
  <CollapsibleSidebar title="Settings" pinned>
    {#snippet titlePrefix()}
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to projects"
        aria-label="Back to projects"
        onclick={onBack}
      >
        <ArrowLeft size={14} />
      </button>
    {/snippet}

    {#snippet footer()}
      <button
        class="flex w-full items-center gap-2 px-3 py-2.5 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to projects"
        onclick={onBack}
      >
        <ArrowLeft size={14} />
        Back
      </button>
    {/snippet}

    <nav class="space-y-px" aria-label="Settings sections">
      {#each tabs as tab (tab.id)}
        {@const Icon = tab.icon}
        {@const isActive = section === tab.id}
        <button
          class="flex w-full items-center gap-2 border-l-2 px-2 py-1.5 text-left text-[13px] transition-colors {isActive
            ? 'border-foreground bg-elevated text-foreground'
            : 'border-transparent text-muted hover:border-border-strong hover:bg-elevated hover:text-foreground'}"
          aria-current={isActive ? 'page' : undefined}
          title="{tab.label} settings"
          onclick={() => onNavigateSection(tab.id)}
        >
          <Icon size={14} class={isActive ? 'text-foreground' : 'text-dimmed'} />
          {tab.label}
        </button>
      {/each}
    </nav>
  </CollapsibleSidebar>

  <!-- Tab content -->
  <div class="min-w-0 flex-1 overflow-y-auto">
    {#if section === 'general'}
      <div class="mx-auto max-w-2xl p-6 pb-24">
        <div class="mb-6">
          <h1 class="text-xl font-bold tracking-tight">General</h1>
          <p class="mt-0.5 text-sm text-muted">
            Configure {APP_NAME} appearance and defaults.
          </p>
          {#if error}
            <p class="mt-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
              {error}
            </p>
          {/if}
        </div>

        <div class="space-y-4">
          <!-- Appearance -->
          <div class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
              Appearance
            </h3>
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium">Theme</p>
                <p class="text-xs text-dimmed">Follow the system or pick a mode</p>
              </div>
              <div class="flex items-center gap-0.5 rounded-lg border bg-elevated p-0.5">
                {#each themeOptions as option (option.id)}
                  {@const Icon = option.icon}
                  <button
                    class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {config.theme ===
                    option.id
                      ? 'bg-surface text-foreground shadow-sm'
                      : 'text-muted hover:text-foreground'}"
                    aria-pressed={config.theme === option.id}
                    disabled={!settingsReady}
                    title="Use the {option.label.toLowerCase()} theme"
                    onclick={() => setPreference(option.id)}
                  >
                    <Icon size={13} />
                    {option.label}
                  </button>
                {/each}
              </div>
            </div>
          </div>

          <!-- Notifications -->
          <div class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">
              Notifications
            </h3>
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-sm font-medium">System notifications</p>
                <p class="text-xs text-dimmed">
                  Alert when an agent finishes, needs attention, or encounters an error
                </p>
                <p class="mt-1 text-[11px] text-dimmed">
                  On macOS, the first test requests permission. Native delivery requires a signed
                  app.
                </p>
                {#if notificationPermission?.platform === 'darwin' && notificationPermission.status === 'granted'}
                  <p class="mt-2 flex items-center gap-1.5 text-xs text-primary">
                    <CheckCircle2 size={13} />
                    Notifications are allowed
                  </p>
                {/if}
                {#if notificationPermission?.platform === 'darwin' && notificationPermission.status === 'denied'}
                  <div
                    class="mt-3 flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2"
                    role="alert"
                  >
                    <div class="flex items-start gap-2">
                      <AlertTriangle size={14} class="mt-0.5 shrink-0 text-warning" />
                      <div>
                        <p class="text-xs font-medium text-warning">Notifications are blocked</p>
                        <p class="mt-0.5 text-[11px] leading-relaxed text-muted">
                          macOS is not showing {APP_NAME} notification cards because notifications are
                          disabled in System Settings. This is why you may hear the alert or see the badge
                          without a card.
                        </p>
                      </div>
                    </div>
                    <button
                      class="flex shrink-0 items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15"
                      title="Open System Settings to allow notifications for {APP_NAME}"
                      onclick={openNotificationSettings}
                    >
                      Open settings
                    </button>
                  </div>
                {/if}
                {#if notificationTestResult}
                  <p
                    class={[
                      'mt-2 text-xs',
                      notificationTestFailed ? 'text-danger' : 'text-primary'
                    ]}
                    role={notificationTestFailed ? 'alert' : 'status'}
                  >
                    {notificationTestResult}
                  </p>
                {/if}
              </div>
              <button
                class="flex shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
                disabled={notificationTestBusy}
                title="Request permission and send a test system notification"
                onclick={() => void testSystemNotification()}
              >
                {#if notificationTestBusy}
                  <Loader2 size={13} class="animate-spin" />
                {:else}
                  <Bell size={13} />
                {/if}
                Test notification
              </button>
            </div>
          </div>

          <!-- Power -->
          <div class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Power</h3>
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-sm font-medium">Keep device on while work is in progress</p>
                <p class="text-xs text-dimmed">
                  Prevent the display and system from sleeping while any agent is working
                </p>
              </div>
              <Switch
                checked={config.keepAwakeWhileWorking}
                onchange={() =>
                  void updateConfig({ keepAwakeWhileWorking: !config.keepAwakeWhileWorking })}
                aria-label="Toggle keeping the device awake while work is in progress"
                disabled={!settingsReady}
              />
            </div>
          </div>

          <!-- Recovery -->
          <div class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Recovery</h3>
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-sm font-medium">Auto-resume after usage resets</p>
                <p class="text-xs text-dimmed">
                  Automatically continue threads whose agent hit a usage or rate limit once its
                  reset time passes
                </p>
              </div>
              <Switch
                checked={config.autoRetryAfterReset}
                onchange={() =>
                  void updateConfig({ autoRetryAfterReset: !config.autoRetryAfterReset })}
                aria-label="Toggle auto-resuming threads after a usage reset"
                disabled={!settingsReady}
              />
            </div>
          </div>

          <!-- Threads -->
          <div class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Threads</h3>
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium">Max threads per project</p>
                  <p class="text-xs text-dimmed">
                    Oldest unpinned threads are evicted when exceeded
                  </p>
                </div>
                <input
                  class="w-20 rounded-lg border bg-elevated px-2.5 py-1 text-right text-sm font-medium outline-none focus:border-primary disabled:opacity-50"
                  type="number"
                  min="1"
                  max="1000"
                  step="1"
                  value={config.threadLimit}
                  disabled={!settingsReady}
                  aria-label="Maximum threads per project"
                  onchange={saveThreadLimit}
                />
              </div>
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium">Slash command behavior</p>
                  <p class="text-xs text-dimmed">
                    {slashCommandOptions.find((option) => option.id === config.slashCommandMode)
                      ?.description}
                  </p>
                </div>
                <select
                  class="rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium outline-none focus:border-primary disabled:opacity-50"
                  value={config.slashCommandMode}
                  disabled={!settingsReady}
                  aria-label="Slash command behavior"
                  onchange={(event: SelectChangeEvent) =>
                    void updateConfig({
                      slashCommandMode: event.currentTarget.value as SlashCommandMode
                    })}
                >
                  {#each slashCommandOptions as option (option.id)}
                    <option value={option.id}>{option.label}</option>
                  {/each}
                </select>
              </div>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium">Question timeout</p>
                  <p class="text-xs text-dimmed">Pick the recommended answer after this wait</p>
                </div>
                <label class="flex shrink-0 items-center gap-2 text-xs text-muted">
                  <input
                    class="w-20 rounded-lg border bg-elevated px-2.5 py-1 text-right text-sm font-medium tabular-nums outline-none focus:border-primary disabled:opacity-50"
                    type="number"
                    min="10"
                    max="3600"
                    step="1"
                    value={config.questionTimeoutMs / 1_000}
                    disabled={!settingsReady}
                    aria-label="Question timeout in seconds"
                    onchange={saveQuestionTimeout}
                  />
                  seconds
                </label>
              </div>
            </div>
          </div>
        </div>
      </div>
    {:else if section === 'audits'}
      <AuditSettingsTab {config} {settingsReady} {updateConfig} />
    {:else if section === 'memory'}
      <SettingsMemoryTab
        variant="settings"
        memoryEnabled={config.memory.enabled}
        chatMemoryEnabled={config.memory.chatEnabled}
        onMemoryEnabledChange={(enabled) =>
          updateConfig({
            memory: { enabled, chatEnabled: config.memory.chatEnabled, entries: [] }
          })}
        onChatMemoryEnabledChange={(enabled) =>
          updateConfig({
            memory: { enabled: config.memory.enabled, chatEnabled: enabled, entries: [] }
          })}
      />
    {:else if section === 'harnesses'}
      <ProvidersView />
    {:else if section === 'utilities'}
      <UtilitiesView />
    {:else if section === 'remote'}
      <RemoteSettingsTab />
    {:else if section === 'about'}
      <div class="mx-auto max-w-2xl p-6 pb-24">
        <div class="mb-6">
          <h1 class="text-xl font-bold tracking-tight">About</h1>
          <p class="mt-0.5 text-sm text-muted">
            Build, product information, data storage, and diagnostics.
          </p>
        </div>

        <!-- Version info -->
        <div class="rounded-xl border bg-surface p-4">
          <div class="space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-muted">Version</span>
              <span class="font-medium">{updaterState.status.currentVersion ?? '0.1.0'}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted">Architecture</span>
              <span class="font-medium">Electron + Svelte 5</span>
            </div>
            <div class="flex justify-between">
              <span class="text-muted">Purpose</span>
              <span class="font-medium">Coordinated agent development</span>
            </div>
          </div>
        </div>

        <!-- Storage -->
        <div class="mt-4 rounded-xl border bg-surface p-4">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Storage</h3>
          <div class="flex items-center justify-between">
            <div>
              <p class="text-sm font-medium">Data directory</p>
              <p class="text-xs text-dimmed">All projects, threads, and history stored here</p>
            </div>
            <span class="rounded-lg bg-elevated px-2.5 py-1 font-mono text-xs text-muted">
              ~/.config/{ORG_SLUG}/{APP_SLUG}
            </span>
          </div>
        </div>

        <!-- Diagnostics -->
        <div class="mt-4 rounded-xl border bg-surface p-4">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Diagnostics</h3>
          <div class="flex items-center justify-between gap-4">
            <div>
              <p class="text-sm font-medium">Export failure report</p>
              <p class="text-xs text-dimmed">
                Redacted logs and operational state; prompts and file contents are excluded.
              </p>
              {#if diagnosticsResult}
                <p class="mt-1 max-w-md break-all text-[11px] text-muted">
                  {diagnosticsResult}
                </p>
              {/if}
            </div>
            <button
              class="flex shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
              disabled={diagnosticsBusy}
              title="Export a redacted diagnostics report"
              onclick={() => void exportDiagnostics()}
            >
              {#if diagnosticsBusy}
                <Loader2 size={13} class="animate-spin" />
              {:else}
                <Download size={13} />
              {/if}
              Export
            </button>
          </div>
        </div>

        <!-- Updates -->
        <div class="mt-4 rounded-xl border bg-surface p-4">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Updates</h3>

          <!-- Update status -->
          {#if updaterState.status.state === 'checking'}
            <div class="mb-3 flex items-center gap-2 text-xs text-muted">
              <Loader2 size={13} class="animate-spin" />
              Checking for updates…
            </div>
          {:else if updaterState.status.state === 'available'}
            <div class="mb-3 flex items-center gap-2 text-xs text-primary">
              <Download size={13} />
              <span>
                Update <strong>{updaterState.status.availableVersion}</strong> available
              </span>
            </div>
          {:else if updaterState.status.state === 'downloading'}
            <div class="mb-3">
              <div class="flex items-center gap-2 text-xs text-muted">
                <Loader2 size={13} class="animate-spin" />
                Downloading update…
              </div>
              {#if updaterState.status.downloadProgress !== undefined}
                <div class="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-elevated">
                  <div
                    class="h-full rounded-full bg-primary transition-all"
                    style="width: {updaterState.status.downloadProgress}%"
                  ></div>
                </div>
                <p class="mt-0.5 text-right text-[11px] tabular-nums text-dimmed">
                  {updaterState.status.downloadProgress}%
                </p>
              {/if}
            </div>
          {:else if updaterState.status.state === 'downloaded'}
            <div class="mb-3 flex items-center gap-2 text-xs text-primary">
              <CheckCircle2 size={13} />
              <span>
                Update <strong>{updaterState.status.availableVersion}</strong> ready to install
              </span>
            </div>
          {:else if updaterState.status.state === 'waiting'}
            <div class="mb-3 flex items-center gap-2 text-xs text-accent">
              <Clock size={13} />
              <span>
                Waiting for {updaterState.waitingForThreads} active thread{updaterState.waitingForThreads !==
                1
                  ? 's'
                  : ''} to finish before installing…
              </span>
            </div>
          {:else if updaterState.status.state === 'error'}
            <div class="mb-3 flex items-center gap-2 text-xs text-danger">
              <AlertCircle size={13} />
              <span>{updaterState.status.errorMessage ?? 'Update check failed'}</span>
            </div>
          {:else if updaterState.status.state === 'idle' && updaterState.status.canAutoUpdate}
            <div class="mb-3 flex items-center gap-2 text-xs text-dimmed">
              <CheckCircle2 size={13} />
              <span>{APP_NAME} is up to date</span>
            </div>
          {/if}

          <div class="space-y-3">
            <!-- Nightly builds enrollment -->
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-sm font-medium">Nightly builds</p>
                <p class="text-xs text-dimmed">
                  Receive over-the-air updates from the nightly channel
                </p>
              </div>
              <Switch
                checked={isNightlyChannel}
                onchange={onNightlyToggleRequested}
                aria-label="Toggle nightly builds"
                disabled={!settingsReady || channelBusy}
                title="Opt into nightly prerelease builds"
              />
            </div>

            <!-- Auto-download toggle -->
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium">Auto-download</p>
                <p class="text-xs text-dimmed">Automatically download updates when available</p>
              </div>
              <Switch
                checked={config.autoDownloadUpdates}
                onchange={() =>
                  void updateConfig({ autoDownloadUpdates: !config.autoDownloadUpdates })}
                aria-label="Toggle auto-download"
                disabled={!settingsReady}
              />
            </div>

            <!-- Auto-install toggle -->
            <div class="flex items-center justify-between">
              <div>
                <p class="text-sm font-medium">Auto-install</p>
                <p class="text-xs text-dimmed">Automatically restart and install after download</p>
              </div>
              <Switch
                checked={config.autoInstallUpdates}
                onchange={() =>
                  void updateConfig({ autoInstallUpdates: !config.autoInstallUpdates })}
                aria-label="Toggle auto-install"
                disabled={!settingsReady}
              />
            </div>

            <!-- Action buttons -->
            <div class="flex items-center gap-2 pt-1">
              <button
                class="flex items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
                disabled={updaterState.status.state === 'checking' || !settingsReady}
                title="Check for updates now"
                onclick={() => void updaterState.checkForUpdates()}
              >
                <RefreshCw
                  size={13}
                  class={updaterState.status.state === 'checking' ? 'animate-spin' : ''}
                />
                Check for updates
              </button>

              {#if updaterState.status.state === 'available'}
                <button
                  class="flex items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
                  title="Download update"
                  onclick={() => void updaterState.downloadUpdate()}
                >
                  <Download size={13} />
                  Download
                </button>
              {/if}

              {#if updaterState.status.state === 'downloaded'}
                <button
                  class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                  title="Restart and install update"
                  onclick={() => void updaterState.installUpdate()}
                >
                  <RefreshCw size={13} />
                  Restart & install
                </button>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

{#if nightlyModalOpen}
  <Modal
    title="Enable nightly builds?"
    size="md"
    open={nightlyModalOpen}
    onClose={() => {
      nightlyModalOpen = false
    }}
  >
    <div class="space-y-3 text-sm text-muted">
      <p>
        Nightly builds are bleeding-edge prereleases generated from the
        <code class="rounded bg-elevated px-1.5 py-0.5 font-mono text-xs text-foreground"
          >nightly</code
        >
        branch. They ship continuously so you can try the latest changes early.
      </p>
      <ul class="list-disc space-y-1 pl-5">
        <li>You may hit <strong class="text-foreground">unfinished features and bugs</strong>.</li>
        <li>
          Updates arrive <strong class="text-foreground">more frequently</strong> than stable releases.
        </li>
        <li>Downgrading to stable later is supported by the updater.</li>
        <li>Opt out any time from this same setting.</li>
      </ul>
      <p class="text-xs text-dimmed">
        Enabling this switches your over-the-air update feed to the nightly channel and checks for
        updates immediately.
      </p>
    </div>
    {#snippet footer()}
      <button
        class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
        title="Keep receiving stable updates"
        onclick={() => {
          nightlyModalOpen = false
        }}
      >
        Cancel
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        title="Enroll in nightly builds"
        disabled={channelBusy}
        onclick={() => void setChannel('nightly')}
      >
        {#if channelBusy}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <Download size={13} />
        {/if}
        Enable nightly builds
      </button>
    {/snippet}
  </Modal>
{/if}
