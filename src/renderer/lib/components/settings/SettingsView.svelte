<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { settingsUiState } from '$lib/stores/settings-ui.svelte'
  import type { SettingsSection } from '$lib/stores/renderer-recovery.svelte'
  import { updaterState } from '$lib/stores/updater.svelte'
  import DownloadProgress from '../ui/DownloadProgress.svelte'
  import type {
    AppConfig,
    AppConfigPatch,
    GitPullPreference,
    PrMergeMethod,
    SkillMarketEntry,
    SlashCommandMode,
    ThemePreference
  } from '$shared/types'
  import type { SystemNotificationPermissionStatus } from '$shared/ipc-contract'
  import { APP_NAME, APP_SLUG, ORG_SLUG } from '$shared/brand'
  import {
    AlertCircle,
    AlertTriangle,
    ArrowLeft,
    Bell,
    CheckCircle2,
    Clock,
    Download,
    FolderOpen,
    Loader2,
    Monitor,
    Moon,
    RefreshCw,
    Search,
    SlidersHorizontal,
    Sun
  } from '@lucide/svelte'
  import CollapsibleSidebar from '../layout/CollapsibleSidebar.svelte'
  import Switch from '../ui/Switch.svelte'
  import Modal from '../ui/Modal.svelte'
  import { SETTINGS_SEARCH_ENTRIES } from '$lib/settings-search'
  import type { SettingsSearchEntry } from '$lib/settings-search'
  import type { ActionDefinition, ActionSelection } from '../../actions/types'
  import ProvidersView from '../providers/ProvidersView.svelte'
  import UtilitiesView from './UtilitiesView.svelte'
  import SkillsMarketplaceView from './SkillsMarketplaceView.svelte'
  import SkillMarketplaceDetail from './SkillMarketplaceDetail.svelte'
  import KeymapSettingsTab from './KeymapSettingsTab.svelte'
  import SettingsMemoryTab from '../memory/MemoryPanel.svelte'
  import AuditSettingsTab from './AuditSettingsTab.svelte'
  import HeartbeatSettingsView from './HeartbeatSettingsView.svelte'
  import RemoteSettingsTab from './RemoteSettingsTab.svelte'
  import ProfileSettingsTab from './ProfileSettingsTab.svelte'
  import CloudDeploymentsSettingsTab from './CloudDeploymentsSettingsTab.svelte'
  import CioPromptsSettings from './CioPromptsSettings.svelte'
  import CuaBridgeSettings from './CuaBridgeSettings.svelte'
  import GatewaySettingsTab from './GatewaySettingsTab.svelte'
  import SoundSettingsTab from './SoundSettingsTab.svelte'
  import CommandPalette from '../actions/CommandPalette.svelte'
  import { toast } from 'svelte-sonner'

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
    /** Returns to the content view that opened Settings. */
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

  type UtilitiesRoute =
    { page: 'catalog' } | { page: 'marketplace' } | { page: 'skill'; entry: SkillMarketEntry }

  interface SettingsHistoryEntry {
    section: SettingsSection
    utilitiesRoute: UtilitiesRoute
  }

  let utilitiesRoute = $state<UtilitiesRoute>({ page: 'catalog' })
  let settingsHistory = $state<SettingsHistoryEntry[]>([])

  function currentSettingsLocation(): SettingsHistoryEntry {
    return { section, utilitiesRoute }
  }

  function navigateSection(nextSection: SettingsSection): void {
    if (
      nextSection === section &&
      (nextSection !== 'utilities' || utilitiesRoute.page === 'catalog')
    ) {
      return
    }
    settingsHistory = [...settingsHistory, currentSettingsLocation()]
    utilitiesRoute = { page: 'catalog' }
    onNavigateSection(nextSection)
  }

  function navigateUtilities(nextRoute: UtilitiesRoute): void {
    settingsHistory = [...settingsHistory, currentSettingsLocation()]
    utilitiesRoute = nextRoute
  }

  function goBack(): void {
    const previous = settingsHistory.at(-1)
    if (!previous) {
      onBack()
      return
    }
    settingsHistory = settingsHistory.slice(0, -1)
    utilitiesRoute = previous.utilitiesRoute
    if (previous.section !== section) onNavigateSection(previous.section)
  }

  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      // The settings spotlight owns Escape while it is open.
      if (settingsSearchOpen) return
      e.preventDefault()
      goBack()
    }
  }

  // ── Settings search spotlight ────────────────────────────────────────────
  let settingsSearchOpen = $state(false)

  const settingsSearchIndex = new Map<string, SettingsSearchEntry>(
    SETTINGS_SEARCH_ENTRIES.map((entry) => [`settings:${entry.id}`, entry])
  )

  const settingsSearchActions = $derived<ActionDefinition[]>(
    SETTINGS_SEARCH_ENTRIES.map((entry) => ({
      id: `settings:${entry.id}`,
      title: entry.title,
      description: entry.description,
      category: 'navigation',
      source: { id: 'app-settings', label: 'Settings', kind: 'app' },
      showSourceBadge: false,
      icon: entry.icon,
      keywords: entry.keywords
    }))
  )

  /** Flashes a block's border three times to draw the eye after navigation. */
  function flashElement(element: HTMLElement): void {
    element.classList.remove('settings-flash')
    void element.offsetWidth // restart cleanly if a flash is already mid-run
    element.classList.add('settings-flash')
    element.addEventListener('animationend', () => element.classList.remove('settings-flash'), {
      once: true
    })
  }

  async function handleSettingsSearch(selection: ActionSelection): Promise<void> {
    const entry = settingsSearchIndex.get(selection.action.id)
    if (!entry) return

    navigateSection(entry.section)
    await tick()
    // One frame so the freshly swapped section content has laid out.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

    if (!entry.blockId) return
    const element = document.getElementById(`settings-block-${entry.blockId}`)
    if (!element) return
    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    flashElement(element)
  }

  // Sidebar tabs come from the settings search registry — the same source the
  // spotlight searches, so a page can never be navigable but not searchable.
  const tabs: Array<{
    id: SettingsSection
    label: string
    icon: typeof SlidersHorizontal
  }> = SETTINGS_SEARCH_ENTRIES.filter((entry) => !entry.blockId).map((entry) => ({
    id: entry.section,
    label: entry.title,
    icon: entry.icon
  }))

  // The header mirrors the section on screen — cleared when Settings closes.
  $effect(() => {
    let activeLabel: string | null = null
    for (const tab of tabs) {
      if (tab.id === section) activeLabel = tab.label
    }
    settingsUiState.activeTabLabel =
      section === 'utilities' && utilitiesRoute.page !== 'catalog'
        ? 'Skills Marketplace'
        : activeLabel
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

  const mergeMethodOptions: Array<{
    id: PrMergeMethod
    label: string
  }> = [
    { id: 'squash', label: 'Squash' },
    { id: 'merge', label: 'Merge' },
    { id: 'rebase', label: 'Rebase' }
  ]

  const pullStrategyOptions: Array<{
    id: GitPullPreference
    label: string
  }> = [
    { id: 'ask', label: 'Ask every time' },
    { id: 'merge', label: 'Merge' },
    { id: 'rebase', label: 'Rebase' },
    { id: 'ff-only', label: 'Fast-forward only' }
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

  function saveMaxDiffLines(event: Event): void {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return

    const value = Number(input.value)
    if (!Number.isInteger(value) || value < 10 || value > 5000) {
      input.value = String(config.maxDiffLines)
      return
    }

    void updateConfig({ maxDiffLines: value })
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

  async function openDataDirectory(): Promise<void> {
    const opened = await invoke('storage:openDataDirectory').catch(() => false)
    if (!opened) toast.error('The data directory could not be opened in the file manager.')
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
    void invoke('notification:openSettings')
  }

  onMount(() => {
    void refreshNotificationPermission()
    // The main process re-verifies a 'denied' state on every permission query
    // and pushes the outcome; keep the panel in sync without a remount.
    const unsubscribePermissionStatus = subscribe('notification:permissionStatus', (status) => {
      notificationPermission = status
    })
    // The user may have just toggled notifications in System Settings —
    // returning to the app must re-derive the state instead of showing a
    // stale warning.
    const onWindowFocus = (): void => {
      void refreshNotificationPermission()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => {
      unsubscribePermissionStatus()
      window.removeEventListener('focus', onWindowFocus)
    }
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
  <CollapsibleSidebar title="Back" pinned>
    {#snippet titlePrefix()}
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Go back"
        aria-label="Go back"
        onclick={goBack}
      >
        <ArrowLeft size={14} />
      </button>
    {/snippet}

    {#snippet header()}
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Search settings"
        aria-label="Search settings"
        onclick={() => (settingsSearchOpen = true)}
      >
        <Search size={14} />
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
          onclick={() => navigateSection(tab.id)}
        >
          <Icon size={14} class={isActive ? 'text-foreground' : 'text-dimmed'} />
          {tab.label}
        </button>
      {/each}
    </nav>

    {#snippet footer()}
      <div class="flex items-center px-2 py-1.5">
        <button
          type="button"
          class="flex h-8 flex-1 items-center gap-2 rounded-lg px-2 text-sm text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Exit settings"
          aria-label="Exit settings"
          onclick={onBack}
        >
          <ArrowLeft size={14} />
          Exit settings
        </button>
      </div>
    {/snippet}
  </CollapsibleSidebar>

  <!-- Tab content -->
  <div class="min-w-0 flex-1 overflow-y-auto">
    {#if section === 'profile'}
      <ProfileSettingsTab />
    {:else if section === 'general'}
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
          <div id="settings-block-general-appearance" class="rounded-xl border bg-surface p-4">
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
          <div id="settings-block-general-notifications" class="rounded-xl border bg-surface p-4">
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

          <!-- Browser -->
          <div id="settings-block-general-browser" class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Browser</h3>
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-sm font-medium">Open localhost on CIO's browser</p>
                <p class="text-xs text-dimmed">
                  Keep local development links inside the workspace for testing
                </p>
              </div>
              <Switch
                checked={config.openLocalhostInCioBrowser}
                onchange={() =>
                  void updateConfig({
                    openLocalhostInCioBrowser: !config.openLocalhostInCioBrowser
                  })}
                aria-label="Toggle opening localhost links in CIO's browser"
                disabled={!settingsReady}
              />
            </div>
          </div>

          <!-- Power -->
          <div id="settings-block-general-power" class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Power</h3>
            <div class="flex items-center justify-between gap-4">
              <div>
                <p class="text-sm font-medium">Keep device on while work is in progress</p>
                <p class="text-xs text-dimmed">
                  Prevent sleep while an agent is actively working; spec-ready threads stay idle
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
          <div id="settings-block-general-recovery" class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Recovery</h3>
            <div class="space-y-4">
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium">Resume work on restart</p>
                  <p class="text-xs text-dimmed">
                    Threads will be resumed if they were interrupted due to an app closure or
                    unknown issues
                  </p>
                </div>
                <Switch
                  checked={config.resumeWorkOnRestart}
                  onchange={() =>
                    void updateConfig({ resumeWorkOnRestart: !config.resumeWorkOnRestart })}
                  aria-label="Toggle resuming interrupted threads after the app restarts"
                  disabled={!settingsReady}
                />
              </div>
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
          </div>

          <!-- Git -->
          <div id="settings-block-general-git" class="rounded-xl border bg-surface p-4">
            <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Git</h3>
            <div class="space-y-3">
              <div class="flex items-center justify-between">
                <div>
                  <p class="text-sm font-medium">Default merge method</p>
                  <p class="text-xs text-dimmed">
                    Pre-selected when merging a pull request from the Git panel
                  </p>
                </div>
                <select
                  class="rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium outline-none focus:border-primary disabled:opacity-50"
                  value={config.defaultMergeMethod}
                  disabled={!settingsReady}
                  aria-label="Default merge method"
                  onchange={(event: SelectChangeEvent) =>
                    void updateConfig({
                      defaultMergeMethod: event.currentTarget.value as PrMergeMethod
                    })}
                >
                  {#each mergeMethodOptions as option (option.id)}
                    <option value={option.id}>{option.label}</option>
                  {/each}
                </select>
              </div>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium">Default pull strategy</p>
                  <p class="text-xs text-dimmed">
                    Ask when pulling, or always use one reconciliation strategy
                  </p>
                </div>
                <select
                  class="rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium outline-none focus:border-primary disabled:opacity-50"
                  value={config.defaultPullStrategy}
                  disabled={!settingsReady}
                  aria-label="Default pull strategy"
                  onchange={(event: SelectChangeEvent) =>
                    void updateConfig({
                      defaultPullStrategy: event.currentTarget.value as GitPullPreference
                    })}
                >
                  {#each pullStrategyOptions as option (option.id)}
                    <option value={option.id}>{option.label}</option>
                  {/each}
                </select>
              </div>
              <div class="flex items-center justify-between gap-4">
                <div>
                  <p class="text-sm font-medium">Maximum diff lines</p>
                  <p class="text-xs text-dimmed">
                    Hunks larger than this are collapsed with a notice so huge diffs stay responsive
                  </p>
                </div>
                <label class="flex shrink-0 items-center gap-2 text-xs text-muted">
                  <input
                    class="w-20 rounded-lg border bg-elevated px-2.5 py-1 text-right text-sm font-medium tabular-nums outline-none focus:border-primary disabled:opacity-50"
                    type="number"
                    min="10"
                    max="5000"
                    step="1"
                    value={config.maxDiffLines}
                    disabled={!settingsReady}
                    aria-label="Maximum diff lines per hunk"
                    onchange={saveMaxDiffLines}
                  />
                  lines
                </label>
              </div>
            </div>
          </div>

          <!-- Threads -->
          <div id="settings-block-general-threads" class="rounded-xl border bg-surface p-4">
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
    {:else if section === 'cio-prompts'}
      <CioPromptsSettings />
    {:else if section === 'heartbeat'}
      <HeartbeatSettingsView />
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
      {#if utilitiesRoute.page === 'catalog'}
        <UtilitiesView onOpenMarketplace={() => navigateUtilities({ page: 'marketplace' })} />
      {:else if utilitiesRoute.page === 'marketplace'}
        <SkillsMarketplaceView
          onOpenSkill={(entry) => navigateUtilities({ page: 'skill', entry })}
        />
      {:else}
        {#key utilitiesRoute.entry.id}
          <SkillMarketplaceDetail entry={utilitiesRoute.entry} />
        {/key}
      {/if}
    {:else if section === 'computer-use'}
      <CuaBridgeSettings />
    {:else if section === 'sound'}
      <SoundSettingsTab settings={config.sound} {settingsReady} {updateConfig} />
    {:else if section === 'gateways'}
      <GatewaySettingsTab />
    {:else if section === 'keymap'}
      <KeymapSettingsTab />
    {:else if section === 'remote'}
      <RemoteSettingsTab />
    {:else if section === 'cloud-deployments'}
      <CloudDeploymentsSettingsTab />
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
        <div id="settings-block-about-storage" class="mt-4 rounded-xl border bg-surface p-4">
          <h3 class="mb-3 text-xs font-semibold uppercase tracking-wide text-muted">Storage</h3>
          <div
            class="flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div>
              <p class="text-sm font-medium">Data directory</p>
              <p class="text-xs text-dimmed">All projects, threads, and history stored here</p>
            </div>
            <div class="flex flex-wrap items-center gap-2 sm:justify-end">
              <span class="rounded-lg bg-elevated px-2.5 py-1 font-mono text-xs text-muted">
                ~/.config/{ORG_SLUG}/{APP_SLUG}
              </span>
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
                title="Open the data directory in the file manager"
                onclick={() => void openDataDirectory()}
              >
                <FolderOpen size={13} />
                Open in file manager
              </button>
            </div>
          </div>
        </div>

        <!-- Diagnostics -->
        <div id="settings-block-about-diagnostics" class="mt-4 rounded-xl border bg-surface p-4">
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
        <div id="settings-block-about-updates" class="mt-4 rounded-xl border bg-surface p-4">
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
              <DownloadProgress
                percent={updaterState.status.downloadProgress}
                label="Downloading update…"
                detail={updaterState.status.downloadProgress !== undefined ? `${updaterState.status.downloadProgress}%` : undefined}
                ariaLabel="Update download progress"
              />
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

{#if settingsSearchOpen}
  <CommandPalette
    open={settingsSearchOpen}
    actions={settingsSearchActions}
    title="Search settings"
    placeholder="Search settings pages and sections…"
    emptyLabel="No matching settings"
    headerIcon={Search}
    onSelect={handleSettingsSearch}
    onClose={() => (settingsSearchOpen = false)}
  />
{/if}

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
