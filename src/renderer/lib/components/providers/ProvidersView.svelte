<script lang="ts">
  import { onMount } from 'svelte'
  import { fade, slide } from 'svelte/transition'
  import {
    AlertTriangle,
    Check,
    CheckCircle2,
    ChevronDown,
    Circle,
    Clock,
    Copy,
    Download,
    Loader2,
    Plug,
    Plus,
    RefreshCw,
    Search,
    Trash2,
    X
  } from '@lucide/svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { copyText } from '$lib/copy-text'
  import { displayShortcutLabel } from '$lib/shortcut-display'
  import { toast } from 'svelte-sonner'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { APP_NAME } from '$shared/brand'
  import type { ProviderAccountAuthStatus, ProviderConnectionInfo } from '$shared/types'
  import type { HarnessManifestEntry } from '$shared/types'
  import BaseUrlProvidersPanel from './BaseUrlProvidersPanel.svelte'
  import AddProviderModal from './AddProviderModal.svelte'
  import BaseUrlProviderEditor from './BaseUrlProviderEditor.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import ThreadDropdown from '../shared/ThreadDropdown.svelte'
  import type { MenuItem } from '../shared/ThreadDropdown.svelte'

  /** Where users can browse existing PRs / open one for a V2 support effort. */
  const OPENCODE_V2_PRS_URL = 'https://github.com/pillardash-oss/codeinoven/pulls'
  /** Human copy shown for an installed-but-unsupported harness. */
  const OPENCODE_V2_NOTICE =
    'Open Code V2 support is not available at the moment. Pending the release of the stable release of Open Code V2.'
  /** How often the "last checked" relative label re-renders. */
  const RELATIVE_TIME_TICK_MS = 20_000
  /** How long a copy confirmation stays visible on the Path column. */
  const COPY_FEEDBACK_MS = 1500

  /** Harnesses whose drivers can consume custom base-URL providers (per the manifest). */
  let baseUrlHarnesses = $derived(
    providerStore.providers.filter(
      (provider) => provider.supportsCustomProviders && provider.integration === 'ready'
    )
  )

  let authStatuses = $state<Record<string, ProviderAccountAuthStatus>>({})
  let addTarget = $state<ProviderConnectionInfo | null>(null)
  let customEditorFor = $state<string | null>(null)
  /** Harness awaiting uninstall confirmation, with its resolved handoff command. */
  let uninstallTarget = $state<ProviderConnectionInfo | null>(null)
  let uninstallCommand = $state<string>('')
  let uninstallLoading = $state(false)
  let uninstallError = $state('')
  let uninstallBusy = $state(false)
  /** Confirmed/effective harness behavior manifests, keyed by harness id. */
  let manifestEntries = $state<Record<string, HarnessManifestEntry>>({})
  let manifestSaving = $state<Record<string, boolean>>({})
  /** Per-harness "update automatically on launch" preference, keyed by harness id. */
  let autoUpdatePrefs = $state<Record<string, boolean>>({})
  let autoUpdateSaving = $state<Record<string, boolean>>({})
  /** Which top-level tab is on screen. */
  let activeTab = $state<'harnesses' | 'custom'>('harnesses')
  /** Per-harness advanced-info disclosure (Settings for ready harnesses, Details for errored ones), collapsed by default. */
  let expandedSettings = $state<Record<string, boolean>>({})
  /** Free-text filter over harness name/command/path. */
  let searchQuery = $state('')
  /** Status chip filter above the harness list. */
  let statusFilter = $state<'all' | 'updates' | 'issues'>('all')
  let searchInputEl = $state<HTMLInputElement | undefined>(undefined)
  /** Epoch ms of the most recent successful check pass, for the "Last checked" label. */
  let lastCheckedAt = $state<number | null>(null)
  /** Ticks on an interval so the relative "last checked" label stays fresh. */
  let now = $state(Date.now())
  /** Harness id whose resolved path was just copied — drives the Copy → Check icon swap. */
  let copiedPathId = $state<string | null>(null)
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined

  let allCount = $derived(providerStore.providers.length)
  let updatesCount = $derived(
    providerStore.providers.filter((provider) =>
      harnessLifecycleStore.updateAvailableFor(provider.id)
    ).length
  )
  let issuesCount = $derived(
    providerStore.providers.filter((provider) => provider.status === 'error').length
  )
  let readyCount = $derived(
    providerStore.providers.filter(
      (provider) =>
        provider.status === 'available' &&
        provider.integration === 'ready' &&
        !harnessLifecycleStore.updateAvailableFor(provider.id)
    ).length
  )

  let filteredProviders = $derived.by(() => {
    let list = providerStore.providers
    if (statusFilter === 'updates') {
      list = list.filter((provider) => harnessLifecycleStore.updateAvailableFor(provider.id))
    } else if (statusFilter === 'issues') {
      list = list.filter((provider) => provider.status === 'error')
    }
    const query = searchQuery.trim().toLowerCase()
    if (!query) return list
    return list.filter(
      (provider) =>
        provider.name.toLowerCase().includes(query) ||
        provider.command.toLowerCase().includes(query) ||
        (provider.resolvedPath?.toLowerCase().includes(query) ?? false)
    )
  })

  let lastCheckedLabel = $derived(
    lastCheckedAt === null
      ? 'Not checked yet'
      : `Last checked: ${formatRelativeTime(lastCheckedAt, now)}`
  )

  function formatRelativeTime(fromMs: number, toMs: number): string {
    const diffSec = Math.max(0, Math.round((toMs - fromMs) / 1000))
    if (diffSec < 5) return 'just now'
    if (diffSec < 60) return `${diffSec}s ago`
    const diffMin = Math.round(diffSec / 60)
    if (diffMin < 60) return `${diffMin} min ago`
    const diffHour = Math.round(diffMin / 60)
    if (diffHour < 24) return `${diffHour}h ago`
    const diffDay = Math.round(diffHour / 24)
    return `${diffDay}d ago`
  }

  function toggleSettings(harnessId: string): void {
    expandedSettings[harnessId] = !expandedSettings[harnessId]
  }

  /** True when a harness row has a Settings or Details panel to disclose. */
  function hasDisclosure(provider: ProviderConnectionInfo): boolean {
    return (
      (provider.status === 'available' && provider.integration === 'ready') ||
      provider.status === 'error'
    )
  }

  function manifestFor(harnessId: string): HarnessManifestEntry | undefined {
    return manifestEntries[harnessId]
  }

  interface BadgeInfo {
    Icon: typeof CheckCircle2
    label: string
    classes: string
    spin?: boolean
  }

  /** Single, mutually-exclusive status badge per harness row. */
  function badgeFor(provider: ProviderConnectionInfo): BadgeInfo {
    if (provider.unsupportedReason === 'opencode-v2') {
      return {
        Icon: AlertTriangle,
        label: 'Not supported yet',
        classes: 'border-warning/30 bg-warning/10 text-warning'
      }
    }
    if (provider.status === 'error') {
      return {
        Icon: AlertTriangle,
        label: 'Needs attention',
        classes: 'border-danger/30 bg-danger/10 text-danger'
      }
    }
    if (
      provider.status === 'available' &&
      provider.integration === 'ready' &&
      harnessLifecycleStore.updateAvailableFor(provider.id)
    ) {
      return {
        Icon: Download,
        label: 'Update available',
        classes: 'border-warning/30 bg-warning/10 text-warning'
      }
    }
    if (provider.status === 'available' && provider.integration === 'ready') {
      return {
        Icon: CheckCircle2,
        label: 'Ready',
        classes: 'border-success/30 bg-success/10 text-success'
      }
    }
    if (provider.status === 'available') {
      return {
        Icon: Circle,
        label: 'Detected · integration planned',
        classes: 'border-warning/30 bg-warning/10 text-warning'
      }
    }
    if (provider.status === 'checking') {
      return {
        Icon: Loader2,
        label: 'Checking…',
        classes: 'border-info/30 bg-info/10 text-info',
        spin: true
      }
    }
    if (provider.status === 'not_found') {
      return {
        Icon: Circle,
        label: 'Not installed',
        classes: 'border-border bg-elevated text-dimmed'
      }
    }
    return { Icon: Circle, label: 'Not checked', classes: 'border-border bg-elevated text-dimmed' }
  }

  /** Secondary actions tucked into the row's "..." menu. */
  function menuItemsFor(provider: ProviderConnectionInfo): MenuItem[] {
    const items: MenuItem[] = [
      {
        label: 'Check',
        icon: RefreshCw,
        disabled: provider.status === 'checking',
        onClick: () => void checkOne(provider.id)
      }
    ]
    if (provider.unsupportedReason === 'opencode-v2') {
      items.push({
        label: 'Check PRs',
        onClick: () => void openInBrowser(OPENCODE_V2_PRS_URL)
      })
    }
    if (provider.status === 'available') {
      items.push({ label: `divider-${provider.id}`, divider: true })
      items.push({
        label: 'Uninstall',
        icon: Trash2,
        danger: true,
        disabled: harnessLifecycleStore.isRunning(provider.id),
        onClick: () => void requestUninstall(provider)
      })
    }
    return items
  }

  async function copyPath(provider: ProviderConnectionInfo): Promise<void> {
    if (!provider.resolvedPath) return
    try {
      await copyText(provider.resolvedPath)
      copiedPathId = provider.id
      clearTimeout(copyResetTimer)
      copyResetTimer = setTimeout(() => {
        copiedPathId = null
      }, COPY_FEEDBACK_MS)
    } catch {
      // Clipboard unavailable — the button simply stays idle.
    }
  }

  async function loadManifests(): Promise<void> {
    try {
      const entries = await invoke('harnessManifest:list')
      manifestEntries = Object.fromEntries(entries.map((entry) => [entry.harnessId, entry]))
    } catch (manifestError) {
      toast.error(
        manifestError instanceof Error
          ? manifestError.message
          : 'Harness behavior manifests could not be loaded.'
      )
    }
  }

  async function confirmManifestBehavior(
    harnessId: string,
    behavior: string,
    value: boolean
  ): Promise<void> {
    manifestSaving[harnessId] = true
    try {
      await invoke('harnessManifest:confirm', { harnessId, behavior, value })
      await loadManifests()
    } catch (manifestError) {
      toast.error(
        manifestError instanceof Error ? manifestError.message : 'Behavior confirmation failed.'
      )
    } finally {
      manifestSaving[harnessId] = false
    }
  }

  async function resetManifestBehavior(harnessId: string, behavior: string): Promise<void> {
    manifestSaving[harnessId] = true
    try {
      await invoke('harnessManifest:reset', { harnessId, behavior })
      await loadManifests()
    } catch (manifestError) {
      toast.error(manifestError instanceof Error ? manifestError.message : 'Manifest reset failed.')
    } finally {
      manifestSaving[harnessId] = false
    }
  }

  function manifestSourceLabel(entry: HarnessManifestEntry): string {
    if (!entry.confirmed) return 'declared in manifest'
    return entry.confirmed.source === 'user' ? 'confirmed by you' : 'confirmed in use'
  }

  async function loadAutoUpdatePrefs(): Promise<void> {
    try {
      autoUpdatePrefs = await invoke('harnessAutoUpdate:list')
    } catch (autoUpdateError) {
      toast.error(
        autoUpdateError instanceof Error
          ? autoUpdateError.message
          : 'Harness auto-update preferences could not be loaded.'
      )
    }
  }

  async function setAutoUpdatePref(harnessId: string, value: boolean): Promise<void> {
    autoUpdateSaving[harnessId] = true
    try {
      await invoke('harnessAutoUpdate:set', { harnessId, value })
      await loadAutoUpdatePrefs()
    } catch (autoUpdateError) {
      toast.error(
        autoUpdateError instanceof Error
          ? autoUpdateError.message
          : 'Auto-update preference could not be saved.'
      )
    } finally {
      autoUpdateSaving[harnessId] = false
    }
  }

  async function openInstallPage(provider: ProviderConnectionInfo): Promise<void> {
    try {
      const info = await invoke('harnessInstall:getInfo', provider.id)
      await openInBrowser(info.pageUrl)
    } catch (installError) {
      toast.error(
        installError instanceof Error ? installError.message : 'Install page unavailable.'
      )
    }
  }

  async function requestUninstall(provider: ProviderConnectionInfo): Promise<void> {
    if (harnessLifecycleStore.isRunning(provider.id)) return
    // Open the confirmation prompt immediately — the command resolves inside it.
    uninstallTarget = provider
    uninstallCommand = ''
    uninstallError = ''
    uninstallLoading = true
    try {
      const handoff = await invoke('harnessUninstall:handoff', provider.id)
      uninstallCommand = `$ ${handoff.command} ${handoff.args.join(' ')}`
    } catch (uninstallErrorValue) {
      uninstallError =
        uninstallErrorValue instanceof Error
          ? uninstallErrorValue.message
          : 'Uninstall unavailable.'
    } finally {
      uninstallLoading = false
    }
  }

  async function confirmUninstall(): Promise<void> {
    if (!uninstallTarget || uninstallLoading || uninstallError) return
    const target = uninstallTarget
    uninstallBusy = true
    try {
      await harnessLifecycleStore.startUninstall(target.id, target.name)
      uninstallTarget = null
      uninstallCommand = ''
    } finally {
      uninstallBusy = false
    }
  }

  function cancelUninstall(): void {
    if (uninstallBusy) return
    uninstallTarget = null
    uninstallCommand = ''
    uninstallError = ''
  }

  function customCountFor(harnessId: string): number {
    return baseUrlProviderStore.providers.filter(
      (provider) => provider.harnessId === harnessId && provider.enabled
    ).length
  }

  function authCountFor(harnessId: string): number {
    return authStatuses[harnessId]?.accounts?.length ?? 0
  }

  function totalProviderCount(harness: ProviderConnectionInfo): number {
    return customCountFor(harness.id) + authCountFor(harness.id)
  }

  async function checkAuth(harnessId: string): Promise<void> {
    try {
      authStatuses[harnessId] = await invoke('providerAccounts:getAuthStatus', harnessId)
    } catch (authError) {
      authStatuses[harnessId] = {
        capabilities: null,
        state: 'error',
        accounts: [],
        detail: authError instanceof Error ? authError.message : 'Authentication check failed.'
      }
    }
  }

  async function checkAllAuth(): Promise<void> {
    const ready = providerStore.providers.filter(
      (provider) => provider.integration === 'ready' && provider.status === 'available'
    )
    await Promise.all(ready.map((provider) => checkAuth(provider.id)))
  }

  async function recheckAll(): Promise<void> {
    await providerStore.checkAll()
    await checkAllAuth()
    await harnessLifecycleStore.checkAll()
    lastCheckedAt = Date.now()
  }

  async function checkOne(id: string): Promise<void> {
    await providerStore.checkOne(id)
    const provider = providerStore.providers.find((candidate) => candidate.id === id)
    if (provider?.status === 'available') await checkAuth(id)
    await harnessLifecycleStore.checkOne(id)
    lastCheckedAt = Date.now()
  }

  function canAddProvider(provider: ProviderConnectionInfo): boolean {
    return provider.integration === 'ready' && provider.status === 'available'
  }

  /** Intercept the global ⌘K/Ctrl+K (normally the command palette) to focus search while this tab is active. */
  function handleWindowKeydown(event: KeyboardEvent): void {
    if (activeTab !== 'harnesses') return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      event.stopPropagation()
      searchInputEl?.focus()
      searchInputEl?.select()
    }
  }

  onMount(() => {
    window.addEventListener('keydown', handleWindowKeydown, true)
    const relativeTimeInterval = setInterval(() => {
      now = Date.now()
    }, RELATIVE_TIME_TICK_MS)

    void (async () => {
      await providerStore.init()
      await providerStore.checkAll()
      await Promise.all([
        checkAllAuth(),
        baseUrlProviderStore.load(),
        harnessLifecycleStore.checkAll(),
        loadManifests(),
        loadAutoUpdatePrefs()
      ])
      lastCheckedAt = Date.now()
    })()

    return () => {
      window.removeEventListener('keydown', handleWindowKeydown, true)
      clearInterval(relativeTimeInterval)
      clearTimeout(copyResetTimer)
    }
  })
</script>

<div class="mx-auto max-w-5xl p-6 pb-24">
  <div class="mb-4 flex items-start justify-between">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Harnesses</h1>
      <p class="mt-0.5 text-sm text-muted">
        Connect the AI coding harnesses you use. {APP_NAME} wraps them — it doesn't replace them.
      </p>
    </div>
  </div>

  <div
    class="mb-4 flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
    role="tablist"
    aria-label="Harness settings tabs"
  >
    <button
      type="button"
      class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors {activeTab === 'harnesses'
        ? 'bg-surface text-foreground shadow-sm'
        : 'text-muted hover:text-foreground'}"
      role="tab"
      aria-selected={activeTab === 'harnesses'}
      title="Show connected harnesses"
      onclick={() => (activeTab = 'harnesses')}
    >
      Harnesses
    </button>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {activeTab ===
      'custom'
        ? 'bg-surface text-foreground shadow-sm'
        : 'text-muted hover:text-foreground'}"
      role="tab"
      aria-selected={activeTab === 'custom'}
      title="Manage custom base URL providers"
      onclick={() => (activeTab = 'custom')}
    >
      Base URL providers
      {#if baseUrlProviderStore.providers.length > 0}
        <span class="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-dimmed">
          {baseUrlProviderStore.providers.length}
        </span>
      {/if}
    </button>
  </div>

  {#if activeTab === 'harnesses'}
    <div class="mb-4 flex flex-wrap items-center gap-2">
      <div class="relative min-w-[200px] flex-1">
        <Search
          size={14}
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <input
          bind:this={searchInputEl}
          bind:value={searchQuery}
          type="text"
          placeholder="Search harnesses…"
          aria-label="Search harnesses"
          class="h-8 w-full rounded-lg border bg-elevated pl-8 pr-14 text-xs text-foreground placeholder:text-dimmed focus:border-primary/50 focus:outline-none"
        />
        <div class="absolute right-2 top-1/2 -translate-y-1/2">
          {#if searchQuery}
            <button
              type="button"
              class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-surface hover:text-foreground"
              aria-label="Clear search"
              title="Clear search"
              onclick={() => {
                searchQuery = ''
                searchInputEl?.focus()
              }}
            >
              <X size={12} />
            </button>
          {:else}
            <kbd
              class="rounded-md border border-border-strong bg-raised px-1.5 py-0.5 font-sans text-[10px] font-medium text-dimmed"
            >
              {displayShortcutLabel('Ctrl K')}
            </kbd>
          {/if}
        </div>
      </div>

      <div
        class="flex shrink-0 items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
        role="tablist"
        aria-label="Filter harnesses by status"
      >
        <button
          type="button"
          role="tab"
          aria-selected={statusFilter === 'all'}
          title="Show all harnesses"
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {statusFilter ===
          'all'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          onclick={() => (statusFilter = 'all')}
        >
          All
          <span class="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-dimmed"
            >{allCount}</span
          >
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={statusFilter === 'updates'}
          title="Show harnesses with an update available"
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {statusFilter ===
          'updates'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          onclick={() => (statusFilter = 'updates')}
        >
          {#if updatesCount > 0}
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" aria-hidden="true"></span>
          {/if}
          Updates
          <span class="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-dimmed"
            >{updatesCount}</span
          >
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={statusFilter === 'issues'}
          title="Show harnesses that need attention"
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {statusFilter ===
          'issues'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          onclick={() => (statusFilter = 'issues')}
        >
          {#if issuesCount > 0}
            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-danger" aria-hidden="true"></span>
          {/if}
          Issues
          <span class="rounded-full bg-elevated px-1.5 py-0.5 text-[10px] text-dimmed"
            >{issuesCount}</span
          >
        </button>
      </div>

      <button
        class="flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
        title="Re-check all harnesses"
        onclick={() => void recheckAll()}
        disabled={providerStore.checkingCount > 0}
      >
        <RefreshCw size={12} class={providerStore.checkingCount > 0 ? 'animate-spin' : ''} />
        Check all
      </button>
    </div>

    <div class="space-y-3">
      {#each filteredProviders as provider (provider.id)}
        {@const badge = badgeFor(provider)}
        {@const expanded = expandedSettings[provider.id] === true}
        <div
          class="rounded-xl border bg-surface p-4 transition-colors {expanded
            ? 'border-l-[3px] border-l-primary'
            : ''}"
        >
          <div class="grid grid-cols-[13rem_10rem_11rem_minmax(0,1fr)_auto] items-center gap-3">
            <div class="flex min-w-0 items-center gap-3">
              <div class="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-elevated">
                <AgentIcon agentId={provider.id} label={provider.name} size={20} />
              </div>
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{provider.name}</p>
                {#if provider.version}
                  <p class="truncate font-mono text-[10px] text-dimmed">{provider.version}</p>
                {/if}
              </div>
            </div>

            <div class="min-w-0">
              {#key provider.status}
                <span
                  class="inline-flex max-w-full items-center gap-1.5 truncate rounded-lg border px-2.5 py-1 text-[11px] font-medium {badge.classes}"
                  in:fade={{ duration: 150 }}
                  title={badge.label}
                >
                  <badge.Icon size={12} class="shrink-0 {badge.spin ? 'animate-spin' : ''}" />
                  <span class="truncate">{badge.label}</span>
                </span>
              {/key}
            </div>

            <div class="min-w-0">
              <p class="text-[10px] font-medium uppercase tracking-wide text-dimmed">Path</p>
              <div class="mt-0.5 flex items-center gap-1.5">
                <span
                  class="min-w-0 truncate font-mono text-xs text-muted"
                  title={provider.resolvedPath}
                >
                  {provider.resolvedPath ??
                    (provider.status === 'not_found' ? 'Not found on PATH' : 'Not available')}
                </span>
                {#if provider.resolvedPath}
                  <button
                    type="button"
                    class="flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                    title="Copy path"
                    aria-label="Copy {provider.name} path"
                    onclick={() => void copyPath(provider)}
                  >
                    {#if copiedPathId === provider.id}
                      <Check size={11} class="text-success" />
                    {:else}
                      <Copy size={11} />
                    {/if}
                  </button>
                {/if}
              </div>
            </div>

            <div class="min-w-0">
              {#if provider.status === 'error'}
                <p class="text-[10px] font-medium uppercase tracking-wide text-dimmed">Issue</p>
                <p class="mt-0.5 truncate text-xs text-danger" title={provider.detail}>
                  {provider.detail ?? 'Needs attention'}
                </p>
              {:else if provider.status === 'available'}
                <p class="text-[10px] font-medium uppercase tracking-wide text-dimmed">Providers</p>
                <p class="mt-0.5 truncate text-xs text-muted">
                  {totalProviderCount(provider)} provider{totalProviderCount(provider) === 1
                    ? ''
                    : 's'}{#if authStatuses[provider.id] !== undefined}
                    · {customCountFor(provider.id)} custom · {authCountFor(provider.id)} signed in
                  {/if}
                </p>
              {:else}
                <p class="text-[10px] font-medium uppercase tracking-wide text-dimmed">Providers</p>
                <p class="mt-0.5 text-xs text-dimmed">—</p>
              {/if}
            </div>

            <div class="flex items-center justify-end gap-2">
              {#if provider.status === 'error'}
                <button
                  class="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
                  title="Re-check {provider.name}"
                  onclick={() => void checkOne(provider.id)}
                >
                  <RefreshCw size={13} />
                  Retry
                </button>
                <button
                  class="rounded-lg border px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
                  title="{expanded ? 'Hide' : 'Show'} error details for {provider.name}"
                  aria-expanded={expanded}
                  onclick={() => toggleSettings(provider.id)}
                >
                  View details
                </button>
              {:else}
                {#if provider.status === 'not_found'}
                  <button
                    class="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
                    title="Open the {provider.name} install page for your operating system"
                    onclick={() => void openInstallPage(provider)}
                  >
                    <Download size={13} />
                    Install
                  </button>
                {:else if harnessLifecycleStore.updateAvailableFor(provider.id)}
                  <button
                    class="flex items-center gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning/15 disabled:opacity-50"
                    title="Update {provider.name} to {harnessLifecycleStore.updateAvailableFor(
                      provider.id
                    )?.latestVersion}"
                    disabled={harnessLifecycleStore.isRunning(provider.id)}
                    onclick={() =>
                      void harnessLifecycleStore.startUpdate(provider.id, provider.name)}
                  >
                    {#if harnessLifecycleStore.isRunning(provider.id)}
                      <Loader2 size={13} class="animate-spin" />
                    {:else}
                      <Download size={13} />
                    {/if}
                    Update
                  </button>
                {/if}
                <button
                  class="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
                  title={canAddProvider(provider)
                    ? `Add a provider to ${provider.name}`
                    : 'Install the harness first, then re-check to add providers'}
                  disabled={!canAddProvider(provider)}
                  onclick={() => (addTarget = provider)}
                >
                  <Plus size={13} /> Add provider
                </button>
              {/if}

              <ThreadDropdown
                items={menuItemsFor(provider)}
                title="{provider.name} actions"
                ariaLabel="{provider.name} actions"
              />

              {#if hasDisclosure(provider)}
                <button
                  type="button"
                  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                  aria-expanded={expanded}
                  title="{expanded ? 'Hide' : 'Show'} {provider.name} {provider.status === 'error'
                    ? 'details'
                    : 'settings'}"
                  onclick={() => toggleSettings(provider.id)}
                >
                  <ChevronDown
                    size={14}
                    class="shrink-0 transition-transform {expanded ? 'rotate-180' : ''}"
                  />
                </button>
              {/if}
            </div>
          </div>

          {#if provider.unsupportedReason === 'opencode-v2'}
            <div class="mt-3 flex items-start gap-1.5 border-t border-border pt-2">
              <AlertTriangle size={14} class="mt-0.5 shrink-0 text-warning" />
              <span class="min-w-0 break-words text-xs font-medium text-warning">
                {OPENCODE_V2_NOTICE}
              </span>
            </div>
          {/if}

          {#if expanded}
            <div
              class="mt-3 space-y-2.5 border-t border-border pt-3"
              transition:slide={{ duration: 150 }}
            >
              {#if provider.status === 'error'}
                <p class="text-xs font-semibold text-foreground">Details</p>
                <pre
                  class="overflow-auto rounded-lg border border-border bg-raised p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted"><code
                    >{provider.detail ?? 'No additional detail available.'}</code
                  ></pre>
              {:else}
                <p class="text-xs font-semibold text-foreground">Settings</p>
                {#if manifestFor(provider.id)}
                  {@const entry = manifestFor(provider.id)!}
                  <div class="flex items-center justify-between gap-3">
                    <div class="min-w-0">
                      <p class="text-xs font-medium text-foreground">
                        Harness loads AGENTS.md natively
                      </p>
                      <p
                        class="mt-0.5 truncate text-[10px] text-dimmed"
                        title="When on, {provider.name} reads the project's AGENTS.md itself. {APP_NAME} uses its application Agent behavior prompt for Engineering work."
                      >
                        Harness capability · {manifestSourceLabel(entry)}
                      </p>
                    </div>
                    <div class="flex shrink-0 items-center gap-2">
                      {#if entry.confirmed}
                        <button
                          type="button"
                          class="rounded-md px-2 py-1 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
                          title="Clear the confirmed value and fall back to the declared manifest"
                          disabled={manifestSaving[provider.id]}
                          onclick={() => void resetManifestBehavior(provider.id, 'loadsAgentsMd')}
                        >
                          Reset
                        </button>
                      {/if}
                      <Switch
                        checked={entry.effective}
                        disabled={manifestSaving[provider.id]}
                        onchange={(value) =>
                          void confirmManifestBehavior(provider.id, 'loadsAgentsMd', value)}
                        aria-label={`${provider.name} loads AGENTS.md natively`}
                        title={`Set whether ${provider.name} loads AGENTS.md natively (confirmed override)`}
                      />
                    </div>
                  </div>
                {/if}

                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <p class="text-xs font-medium text-foreground">
                      Update automatically on launch
                    </p>
                    <p
                      class="mt-0.5 truncate text-[10px] text-dimmed"
                      title="When on, {provider.name} is updated in the background whenever you open {APP_NAME}."
                    >
                      Updates in the background when {APP_NAME} opens
                    </p>
                  </div>
                  <div class="flex shrink-0 items-center gap-2">
                    <Switch
                      checked={autoUpdatePrefs[provider.id] === true}
                      disabled={autoUpdateSaving[provider.id]}
                      onchange={(value) => void setAutoUpdatePref(provider.id, value)}
                      aria-label={`Update ${provider.name} automatically on launch`}
                      title={`Set whether ${provider.name} updates automatically on launch`}
                    />
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        </div>
      {:else}
        <div class="rounded-xl border border-dashed p-6 text-center text-xs text-dimmed">
          {#if searchQuery || statusFilter !== 'all'}
            No harnesses match the current filter.
          {:else}
            No harnesses detected yet.
          {/if}
        </div>
      {/each}
    </div>

    <div class="mt-6 rounded-xl border border-dashed p-4 text-center">
      <Plug size={18} class="mx-auto mb-1 text-dimmed" />
      <p class="text-xs text-dimmed">
        Harnesses are detected from your system PATH and verified with a version probe. Install the
        CLI tool and click Check.
      </p>
    </div>

    <div
      class="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-[11px]"
    >
      <div class="flex flex-wrap items-center gap-4">
        <span class="flex items-center gap-1.5 text-success">
          <CheckCircle2 size={12} />
          {readyCount} ready
        </span>
        <span class="flex items-center gap-1.5 text-warning">
          <Download size={12} />
          {updatesCount} update{updatesCount === 1 ? '' : 's'}
        </span>
        <span class="flex items-center gap-1.5 text-danger">
          <AlertTriangle size={12} />
          {issuesCount} issue{issuesCount === 1 ? '' : 's'}
        </span>
      </div>
      <span class="flex items-center gap-1.5 text-dimmed">
        <Clock size={12} />
        {lastCheckedLabel}
      </span>
    </div>
  {:else}
    <BaseUrlProvidersPanel providers={providerStore.providers} />
  {/if}
</div>

{#if addTarget}
  <AddProviderModal
    harness={addTarget}
    onClose={() => (addTarget = null)}
    onAddCustom={(harnessId) => {
      customEditorFor = harnessId
      addTarget = null
    }}
  />
{/if}

{#if customEditorFor}
  <BaseUrlProviderEditor
    provider={null}
    harnesses={baseUrlHarnesses}
    defaultHarnessId={customEditorFor}
    onClose={() => (customEditorFor = null)}
    onSaved={() => (customEditorFor = null)}
  />
{/if}

{#if uninstallTarget}
  <Modal open title={`Uninstall ${uninstallTarget.name}?`} onClose={cancelUninstall}>
    {#snippet footer()}
      <button
        class="h-9 rounded-lg border px-3 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        onclick={cancelUninstall}
      >
        Cancel
      </button>
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-semibold text-on-primary transition-colors hover:bg-danger/90 disabled:opacity-50"
        onclick={() => void confirmUninstall()}
        disabled={uninstallBusy || uninstallLoading || !!uninstallError}
      >
        {#if uninstallBusy}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <Trash2 size={13} />
        {/if}
        Uninstall
      </button>
    {/snippet}
    <div class="space-y-3 text-sm">
      <p class="text-muted">
        This removes {uninstallTarget.name} from your machine using its documented uninstall command.
        The command runs in the embedded terminal where you can watch it and stop it at any time.
      </p>
      {#if uninstallLoading}
        <div
          class="flex items-center gap-2 rounded-lg border border-border bg-raised p-3 font-mono text-xs text-muted"
        >
          <Loader2 size={13} class="animate-spin" />
          Resolving uninstall command…
        </div>
      {:else if uninstallError}
        <div class="rounded-lg border border-danger/30 bg-danger/10 p-3 text-xs text-danger">
          {uninstallError}
        </div>
      {:else}
        <pre
          class="overflow-auto rounded-lg border border-border bg-raised p-3 font-mono text-xs leading-relaxed text-foreground"><code
            >{uninstallCommand}</code
          ></pre>
        <p class="text-xs text-dimmed">
          Your provider accounts and project data in {APP_NAME} are separate from the harness install
          and are not removed.
        </p>
      {/if}
    </div>
  </Modal>
{/if}
