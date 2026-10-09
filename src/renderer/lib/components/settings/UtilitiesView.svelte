<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    BookOpen,
    Bookmark,
    Boxes,
    ChevronDown,
    Globe2,
    KeyRound,
    Loader2,
    Monitor,
    Package,
    Pencil,
    Plus,
    Puzzle,
    RefreshCw,
    Search,
    Server,
    Trash2,
    Upload,
    Wrench,
    X
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { invoke } from '$lib/ipc.svelte'
  import { agentToolsStore } from '$lib/stores/agent-tools.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { installedSkillState } from '$lib/stores/installed-skills.svelte'
  import { skillUpdateState } from '$lib/stores/skill-updates.svelte'
  import { relativeTime } from '$lib/format/relative-time'
  import { publicAssetUrl } from '$lib/static-assets'
  import Switch from '../ui/Switch.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import McpConnectionTester from './McpConnectionTester.svelte'
  import SkillBookmarkButton from './SkillBookmarkButton.svelte'
  import SkillInstalledBadge from './SkillInstalledBadge.svelte'
  import UtilityEditorModal, { type UtilityEditorTarget } from './UtilityEditorModal.svelte'
  import { skillBookmarkState, skillBookmarkTitle } from '$lib/stores/skill-bookmarks.svelte'
  import { utilitiesViewPrefs } from '$lib/stores/utilities-view-prefs.svelte'
  import VendorIcon from '../../vendor-icons/VendorIcon.svelte'
  import {
    bookmarkVendor,
    groupRowsByVendor,
    nativeCapabilityVendor,
    registryUtilityVendor,
    type UtilityVendor
  } from './utility-vendors'
  import { APP_NAME } from '$shared/brand'
  import { skillSearchKeywords } from '$shared/skill-search-keywords'
  import type {
    AgentCapabilityEntry,
    AgentToolDefinition,
    McpProbeTarget,
    SkillMarketEntry,
    UtilityBundleInstallRequest,
    UtilityDefinition,
    UtilityKind
  } from '$shared/types'
  import { ALL_HARNESSES_BINDING_ID } from '$shared/types'
  import { canToggleUtilityEnabled, isComputerUseUtility } from '$shared/utility-ids'
  import type { UtilitiesTab } from '$lib/stores/settings-route.svelte'

  /** Sections of the Utilities page; the selected one lives in the settings route. */

  interface Props {
    /** Section currently on screen. */
    activeTab: UtilitiesTab
    onSelectTab: (tab: UtilitiesTab) => void
    onOpenMarketplace: () => void
    onOpenPluginMarketplace: () => void
    /** Opens one marketplace skill from the bookmarks list. */
    onOpenSkill: (entry: SkillMarketEntry) => void
  }

  let { activeTab, onSelectTab, onOpenMarketplace, onOpenPluginMarketplace, onOpenSkill }: Props =
    $props()

  const cioIconUrl = publicAssetUrl('icon.svg')

  /** An installed utility or harness capability row. */
  type UtilityRowItem =
    | {
        id: string
        src: 'registry'
        utility: UtilityDefinition
        name: string
        description: string
        /** Vendor identifiers the skill body names, beyond name and description. */
        keywords: string
        enabled: boolean
        appOwned: boolean
        tags: string[]
        /** Vendor the row is grouped and attributed to. */
        vendor: UtilityVendor
      }
    | {
        id: string
        src: 'native'
        entry: AgentCapabilityEntry
        name: string
        description: string
        keywords: string
        enabled: boolean
        appOwned: false
        tags: string[]
        /** Vendor the row is grouped and attributed to. */
        vendor: UtilityVendor
      }

  /** A marketplace skill the user bookmarked without installing it. */
  type BookmarkRowItem = {
    id: string
    src: 'bookmark'
    entry: SkillMarketEntry
    name: string
    description: string
    keywords: string
    tags: string[]
    /** Vendor the row is grouped and attributed to. */
    vendor: UtilityVendor
  }

  type RowItem = UtilityRowItem | BookmarkRowItem

  interface ToolGroup {
    key: string
    definition: AgentToolDefinition
    harnessIds: string[]
    sentWhen: string[]
  }

  let utilities = $state<UtilityDefinition[]>([])
  let capabilities = $state<{ mcp: AgentCapabilityEntry[]; skill: AgentCapabilityEntry[] } | null>(
    null
  )
  let secureStorageAvailable = $state(true)
  let loading = $state(true)
  let error = $state('')
  let query = $state('')
  let searchInputEl = $state<HTMLInputElement | null>(null)
  let scopeFilter = $state('all')
  let editorOpen = $state(false)
  let editorTarget = $state<UtilityEditorTarget | null>(null)
  let pluginManifest = $state('')

  let tabs: Array<{ id: UtilitiesTab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'skills', label: 'Skills' },
    { id: 'bookmarks', label: 'Bookmarks' },
    { id: 'mcp', label: 'MCP' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'web', label: 'Web & browser' },
    { id: 'tools', label: 'Tools' }
  ]

  const TAB_BLURB: Record<UtilitiesTab, string> = {
    all: `Every skill, MCP server, browser, and web utility installed in ${APP_NAME}.`,
    skills: 'Skills for every harness plus the shared global layer.',
    bookmarks:
      'Marketplace skills you bookmarked, without installing them, so they stay one click away.',
    mcp: 'MCP servers for every harness plus the shared global layer.',
    plugins: 'Install a plugin bundle that adds capabilities together.',
    web: 'Browser control, web search, web fetch, provider, and image-description utilities.',
    tools: 'Inspect stable tool references and the exact schemas exposed to agent models.'
  }

  const isListTab = (tab: UtilitiesTab): boolean =>
    tab === 'all' ||
    tab === 'skills' ||
    tab === 'bookmarks' ||
    tab === 'mcp' ||
    tab === 'web' ||
    tab === 'tools'

  const SEARCH_PLACEHOLDER: Record<UtilitiesTab, string> = {
    all: 'Search all utilities',
    skills: 'Search skills',
    bookmarks: 'Search bookmarked skills',
    mcp: 'Search MCP servers',
    plugins: 'Search plugins',
    web: 'Search web & browser utilities',
    tools: 'Search names, sources, and descriptions'
  }

  /** One-line tooltip per tab, so a hover names the section without acronym noise. */
  const TAB_TITLE: Record<UtilitiesTab, string> = {
    all: 'Every installed utility',
    skills: 'Installed skills',
    bookmarks: 'Bookmarked marketplace skills',
    mcp: 'MCP servers',
    plugins: 'Install a plugin bundle',
    web: 'Web and browser utilities',
    tools: 'Agent tool schemas'
  }

  function harnessName(harnessId: string): string {
    return (
      providerStore.providers.find((provider) => provider.id === harnessId)?.name ??
      getAgentIcon(harnessId)?.name ??
      harnessId
    )
  }

  function kindLabel(kind: UtilityKind): string {
    const kinds: Array<{ id: UtilityKind; label: string }> = [
      { id: 'web_search', label: 'Web search' },
      { id: 'web_fetch', label: 'Web fetch' },
      { id: 'provider', label: 'Provider' },
      { id: 'image_descriptor', label: 'Image descriptor' },
      { id: 'computer_use', label: 'Browser control' }
    ]
    return kinds.find((item) => item.id === kind)?.label ?? kind
  }

  function nativeTags(entry: AgentCapabilityEntry): string[] {
    const tags: string[] = []
    if (entry.origin === 'global') tags.push(entry.projectId ? 'Project' : 'Global')
    if (entry.harnessId) tags.push(entry.harnessId)
    return tags
  }

  function registryTags(utility: UtilityDefinition): string[] {
    return [
      'App',
      ...(utility.scope.level === 'global' ? ['Global'] : []),
      ...(utility.scope.level === 'project' ? ['Project'] : []),
      ...(utility.scope.level === 'thread' ? ['Thread'] : []),
      ...utility.harnessBindings.map((binding) =>
        binding.harnessId === ALL_HARNESSES_BINDING_ID ? 'All harnesses' : binding.harnessId
      )
    ]
  }

  function nativeRows(entries: AgentCapabilityEntry[]): UtilityRowItem[] {
    return entries.map((entry) => ({
      id: entry.id,
      src: 'native' as const,
      entry,
      name: entry.name,
      description: entry.description ?? '',
      keywords: entry.searchKeywords ?? '',
      enabled: entry.enabled,
      appOwned: false,
      tags: nativeTags(entry),
      vendor: nativeCapabilityVendor(entry, harnessName)
    }))
  }

  /** Vendor identifiers each registry skill names in its body. Resolved once
   *  per row build, so typing in the search box only filters rows already
   *  carrying their keywords. */
  function registryRows(utilities: UtilityDefinition[]): UtilityRowItem[] {
    return utilities.map((utility) => ({
      id: `registry:${utility.id}`,
      src: 'registry' as const,
      utility,
      name: utility.name,
      description: utility.description ?? '',
      keywords: utility.kind === 'skill' ? skillSearchKeywords(utility.config.instructions) : '',
      enabled: utility.enabled,
      appOwned: Boolean(utility.appOwned),
      tags: registryTags(utility),
      vendor: registryUtilityVendor(utility, installedSkillState.locations)
    }))
  }

  const WEB_KINDS: Array<UtilityKind> = [
    'web_search',
    'web_fetch',
    'provider',
    'image_descriptor',
    'computer_use'
  ]

  /** Rows for the active section. Derived rather than called, so skill body
   *  keywords are extracted once per registry or capability load and typing in
   *  the search box only filters rows that already carry them. */
  let tabRows = $derived.by((): RowItem[] => {
    if (activeTab === 'all') {
      return [
        ...registryRows(
          utilities.filter(
            (utility) => utility.kind === 'skill' || WEB_KINDS.includes(utility.kind)
          )
        ),
        ...registryRows(utilities.filter((utility) => utility.kind === 'mcp')),
        ...(capabilities
          ? [...nativeRows(capabilities.skill), ...nativeRows(capabilities.mcp)]
          : [])
      ]
    }
    if (activeTab === 'skills') {
      return [
        ...registryRows(utilities.filter((utility) => utility.kind === 'skill')),
        ...(capabilities ? nativeRows(capabilities.skill) : [])
      ]
    }
    if (activeTab === 'mcp') {
      return [
        ...registryRows(utilities.filter((utility) => utility.kind === 'mcp')),
        ...(capabilities ? nativeRows(capabilities.mcp) : [])
      ]
    }
    if (activeTab === 'web') {
      return registryRows(utilities.filter((utility) => WEB_KINDS.includes(utility.kind)))
    }
    if (activeTab === 'bookmarks') return bookmarkRows()
    return []
  })

  /** Bookmarked marketplace skills, newest bookmark first. */
  function bookmarkRows(): BookmarkRowItem[] {
    return skillBookmarkState.bookmarks.map((bookmark) => ({
      id: `bookmark:${bookmark.id}`,
      src: 'bookmark' as const,
      entry: bookmark,
      name: bookmark.name,
      description: bookmark.source,
      keywords: '',
      tags: [],
      vendor: bookmarkVendor(bookmark)
    }))
  }

  function rowIcon(row: UtilityRowItem): typeof BookOpen {
    const kind = row.src === 'registry' ? row.utility.kind : row.entry.kind
    if (kind === 'skill') return BookOpen
    if (kind === 'mcp') return Server
    if (kind === 'computer_use') return Monitor
    return Globe2
  }

  /** An MCP server is a live connection, so its row offers a reachability test. */
  function isMcpRow(row: UtilityRowItem): boolean {
    return row.src === 'registry' ? row.utility.kind === 'mcp' : row.entry.kind === 'mcp'
  }

  /** Test exactly the saved capability the row stands for, with its stored credentials. */
  function mcpProbeTarget(row: UtilityRowItem): McpProbeTarget {
    return row.src === 'registry'
      ? { kind: 'registry', utilityId: row.utility.id }
      : { kind: 'native', source: row.entry.source }
  }

  /**
   * A computer-use connection is only started by the run that claimed the
   * desktop daemon, so it has no standalone test of its own.
   */
  function isComputerUseRow(row: UtilityRowItem): boolean {
    return row.src === 'registry' && isComputerUseUtility(row.utility)
  }

  function rowKindBadge(row: UtilityRowItem): string {
    if (row.src === 'registry') {
      if (row.utility.kind === 'skill') return 'Skill'
      if (row.utility.kind === 'mcp') return 'MCP'
      return kindLabel(row.utility.kind)
    }
    return row.entry.origin === 'global' ? 'Global' : 'Harness'
  }

  let availableTags = $derived.by(() => {
    const tags = Array.from(new Set(tabRows.flatMap((row) => row.tags)))
    tags.sort((a, b) => {
      if (a === 'App') return -1
      if (b === 'App') return 1
      return a.localeCompare(b, undefined, { sensitivity: 'base' })
    })
    return tags
  })

  /**
   * Tag filter that actually applies. A tag carried over from another section
   * falls back to "all", so switching sections is never silently emptied.
   */
  let activeTagFilter = $derived(availableTags.includes(scopeFilter) ? scopeFilter : 'all')

  /** A built-in utility: seeded by the app, never user-installed. */
  function isBuiltInRow(row: RowItem): boolean {
    return row.src === 'registry' && row.appOwned
  }

  let filteredRows = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return tabRows.filter((row) => {
      if (utilitiesViewPrefs.hideBuiltIn && isBuiltInRow(row)) return false
      if (activeTagFilter !== 'all' && !row.tags.includes(activeTagFilter)) return false
      if (!needle) return true
      return [row.name, row.description, row.keywords, ...row.tags].some((value) =>
        value.toLowerCase().includes(needle)
      )
    })
  })

  /** Visible rows under the vendor they came from, app first and local last. */
  let vendorGroups = $derived(groupRowsByVendor(filteredRows))

  /** Built-in rows in the section, so the filter chip only shows when it matters. */
  let builtInRowCount = $derived(tabRows.filter(isBuiltInRow).length)

  /** Built-in rows the current filters hide, so an empty list can explain itself. */
  let hiddenBuiltInCount = $derived(utilitiesViewPrefs.hideBuiltIn ? builtInRowCount : 0)

  function scopeTagLabel(tag: string): string {
    if (tag === 'App') return 'CIO'
    if (tag === 'Global') return 'Global'
    if (tag === 'Project') return 'Project'
    if (tag === 'Thread') return 'Thread'
    if (tag === 'All harnesses') return 'All harnesses'
    return harnessName(tag)
  }

  // Tools tab — reads from the shared, cached agent tool catalog store so
  // switching tabs never re-triggers a driver probe or drops the filters.
  let toolHarnesses = $derived(agentToolsStore.catalog?.harnesses ?? [])
  let selectedToolHarnessDetails = $derived(
    toolHarnesses.find((harness) => harness.id === agentToolsStore.selectedHarness)
  )

  let toolGroups = $derived.by((): ToolGroup[] => {
    const groups: ToolGroup[] = []
    for (const tool of agentToolsStore.catalog?.tools ?? []) {
      const key = [
        tool.source,
        tool.name,
        tool.transportName ?? '',
        tool.description,
        JSON.stringify(tool.inputSchema)
      ].join(' ')
      const existing = groups.find((group) => group.key === key)
      if (existing) {
        if (!existing.harnessIds.includes(tool.harnessId)) existing.harnessIds.push(tool.harnessId)
        if (!existing.sentWhen.includes(tool.sentWhen)) existing.sentWhen.push(tool.sentWhen)
      } else {
        groups.push({
          key,
          definition: tool,
          harnessIds: [tool.harnessId],
          sentWhen: [tool.sentWhen]
        })
      }
    }
    return groups
  })

  let filteredToolGroups = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    const groups = toolGroups
      .filter(
        (group) =>
          agentToolsStore.selectedSource === 'all' ||
          group.definition.source === agentToolsStore.selectedSource
      )
      .filter(
        (group) =>
          agentToolsStore.selectedHarness === null ||
          group.harnessIds.includes(agentToolsStore.selectedHarness)
      )
    if (!needle) return groups
    return groups.filter((group) =>
      [
        group.definition.name,
        group.definition.transportName ?? '',
        group.definition.description,
        group.definition.source,
        ...group.harnessIds,
        ...group.harnessIds.map(toolHarnessName),
        ...group.sentWhen
      ].some((value) => value.toLowerCase().includes(needle))
    )
  })

  function toolHarnessName(harnessId: string): string {
    return toolHarnesses.find((harness) => harness.id === harnessId)?.name ?? harnessId
  }

  function toolHarnessGroupCount(harnessId: string): number {
    return toolGroups.filter((group) => group.harnessIds.includes(harnessId)).length
  }

  function schemaText(tool: AgentToolDefinition): string {
    return JSON.stringify(tool.inputSchema, null, 2)
  }

  function setToolSource(value: string): void {
    if (value === 'all' || value === 'application' || value === 'harness') {
      agentToolsStore.selectedSource = value
    }
  }

  let resultCount = $derived(
    activeTab === 'tools' ? filteredToolGroups.length : filteredRows.length
  )

  /** The skill updater covers installed marketplace skills, not MCP or tools. */
  let showsSkillUpdates = $derived(
    activeTab === 'all' || activeTab === 'skills' || activeTab === 'bookmarks'
  )

  /** What the installed-skill upkeep is, for the hover tooltip. */
  const SKILL_UPDATE_TOOLTIP = `${APP_NAME} re-checks the skills it installed every time the app checks for updates.`

  /** One short line of what the background pass last did, in plain words. */
  let skillUpdateSummary = $derived.by(() => {
    const status = skillUpdateState.status
    if (status.running) return 'Checking for skill updates…'
    if (status.error) return status.error
    const failed = status.results.filter((result) => result.outcome === 'failed').length
    const updated =
      status.updated > 0
        ? `Updated ${status.updated} ${status.updated === 1 ? 'skill' : 'skills'}`
        : ''
    return [
      updated,
      failed > 0 ? `${failed} source${failed === 1 ? '' : 's'} unreachable` : '',
      status.lastCheckedAt ? `checked ${relativeTime(status.lastCheckedAt)}` : ''
    ]
      .filter(Boolean)
      .join(' · ')
  })

  function clearSearch(): void {
    query = ''
    searchInputEl?.focus()
  }

  function replaceUtility(updated: UtilityDefinition): void {
    utilities = utilities.some((utility) => utility.id === updated.id)
      ? utilities.map((utility) => (utility.id === updated.id ? updated : utility))
      : [...utilities, updated]
  }

  function openCreate(): void {
    editorTarget = { kind: 'registry', utility: null }
    editorOpen = true
  }

  function openEdit(row: UtilityRowItem): void {
    if (row.src === 'registry') {
      editorTarget = { kind: 'registry', utility: row.utility }
    } else {
      editorTarget = { kind: 'native', entry: row.entry }
    }
    editorOpen = true
  }

  async function load(): Promise<void> {
    loading = true
    error = ''
    try {
      const [catalog, capabilitiesCatalog] = await Promise.all([
        invoke('utilities:list'),
        invoke('capabilities:listAll')
      ])
      utilities = catalog.utilities
      secureStorageAvailable = catalog.secureStorageAvailable
      capabilities = capabilitiesCatalog
    } catch (loadError) {
      error =
        loadError instanceof Error ? loadError.message : 'The utility catalog could not be loaded.'
    } finally {
      loading = false
    }
  }

  function refreshActiveTab(): void {
    if (activeTab === 'tools') void agentToolsStore.load(true)
    else void load()
  }

  async function toggleEnabled(row: UtilityRowItem): Promise<void> {
    if (row.src !== 'registry') return
    error = ''
    try {
      const updated = await invoke('utilities:update', row.utility.id, {
        enabled: !row.utility.enabled
      })
      utilities = utilities.map((utility) => (utility.id === updated.id ? updated : utility))
    } catch (updateError) {
      error =
        updateError instanceof Error ? updateError.message : 'The utility could not be updated.'
    }
  }

  let deleteTarget = $state<UtilityRowItem | null>(null)
  let deleting = $state(false)

  async function confirmDelete(): Promise<void> {
    const row = deleteTarget
    if (!row) return
    deleting = true
    error = ''
    try {
      if (row.src === 'registry') {
        if (await invoke('utilities:delete', row.utility.id)) {
          utilities = utilities.filter((utility) => utility.id !== row.utility.id)
        }
      } else if (row.entry.kind === 'skill') {
        if (await invoke('capabilities:deleteSkill', row.entry.source)) {
          capabilities = capabilities
            ? { ...capabilities, skill: capabilities.skill.filter((e) => e.id !== row.entry.id) }
            : capabilities
        }
      } else {
        if (await invoke('capabilities:deleteMcp', row.entry.source)) {
          capabilities = capabilities
            ? { ...capabilities, mcp: capabilities.mcp.filter((e) => e.id !== row.entry.id) }
            : capabilities
        }
      }
      deleteTarget = null
    } catch (deleteError) {
      error =
        deleteError instanceof Error ? deleteError.message : 'The capability could not be deleted.'
    } finally {
      deleting = false
    }
  }

  async function readPluginFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) pluginManifest = await file.text()
  }

  async function importPluginBundle(): Promise<void> {
    error = ''
    try {
      const parsed: unknown = JSON.parse(pluginManifest)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The plugin manifest must be a JSON object.')
      }
      await invoke('utilities:installBundle', parsed as UtilityBundleInstallRequest)
      pluginManifest = ''
      await load()
    } catch (installError) {
      error =
        installError instanceof Error ? installError.message : 'The plugin could not be installed.'
    }
  }

  /**
   * Re-read the catalog. The settings shell keeps this page mounted behind the
   * marketplace, which can install or uninstall a skill while this page is
   * invisible, so it calls this when the route returns to the catalog: an
   * uninstalled skill takes its row, and the search keywords that row carries,
   * with it.
   */
  export function reload(): void {
    void load()
  }

  onMount(() => {
    void load()
    void installedSkillState.ensureLoaded()
    void providerStore.init()
    void agentToolsStore.load()
  })
</script>

{#snippet tagChip(tag: string)}
  {#if tag === 'App'}
    <span
      class="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm"
      title={APP_NAME}
    >
      <img class="h-full w-full object-contain" src={cioIconUrl} alt="" />
    </span>
    <span>{scopeTagLabel(tag)}</span>
  {:else if tag === 'Global' || tag === 'Project' || tag === 'Thread' || tag === 'All harnesses'}
    <span>{scopeTagLabel(tag)}</span>
  {:else}
    <AgentIcon agentId={tag} label={scopeTagLabel(tag)} size={14} />
    <span>{scopeTagLabel(tag)}</span>
  {/if}
{/snippet}

{#snippet bookmarkRow(row: BookmarkRowItem)}
  <div class="flex items-start gap-3 p-4">
    <div
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-accent"
    >
      <Bookmark size={15} fill="currentColor" />
    </div>
    <button
      class="min-w-0 flex-1 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      type="button"
      title="Open {row.name} in the marketplace"
      onclick={() => onOpenSkill(row.entry)}
    >
      <span class="flex flex-wrap items-center gap-2">
        <span class="truncate font-mono text-sm font-semibold">{row.name}</span>
        <span
          class="rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted"
        >
          Marketplace
        </span>
        {#if installedSkillState.isInstalled(row.entry.skillId, row.entry.source)}
          <SkillInstalledBadge />
        {/if}
        {#if row.entry.isOfficial}
          <span
            class="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-primary"
          >
            Official
          </span>
        {/if}
      </span>
      <span class="mt-1 block truncate text-xs text-muted">{row.entry.source}</span>
      <span class="mt-1 block text-[0.6875rem] tabular-nums text-dimmed">
        {row.entry.installs.toLocaleString()} installs at bookmark time
      </span>
    </button>
    <div class="flex shrink-0 items-center gap-1">
      <SkillBookmarkButton entry={row.entry} title={skillBookmarkTitle(row.name, true)} />
    </div>
  </div>
{/snippet}

{#snippet utilityRow(row: UtilityRowItem)}
  {@const Icon = rowIcon(row)}
  <div class="flex items-start gap-3 p-4">
    <div
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"
    >
      <Icon size={15} />
    </div>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <p class="text-sm font-semibold">{row.name}</p>
        <span
          class="rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted"
        >
          {rowKindBadge(row)}
        </span>
        {#if row.src === 'registry' && row.appOwned}
          <span
            class="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-primary"
            title={canToggleUtilityEnabled(row.utility)
              ? 'Built into the app. It cannot be deleted, and you can switch it off so it stops competing with your own skill for a topic.'
              : 'Built into the app and always available; it cannot be deleted'}
          >
            Built-in
          </span>
        {/if}
        {#if row.src === 'registry'}
          <span class="text-[0.6875rem] text-dimmed">
            {row.utility.activation === 'always' ? 'Always available' : 'On demand'}
          </span>
        {/if}
      </div>
      {#if row.description}
        <p class="mt-1 text-xs leading-relaxed text-muted">{row.description}</p>
      {/if}
      {#if row.src === 'native' && row.entry.detail}
        <p class="mt-1 truncate font-mono text-[0.625rem] text-dimmed">{row.entry.detail}</p>
      {/if}
      <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-dimmed">
        {#each row.tags as tag (tag)}
          <span
            class="flex h-6 items-center gap-1.5 rounded-md border bg-elevated px-2 text-[0.625rem] font-medium text-muted"
          >
            {@render tagChip(tag)}
          </span>
        {/each}
        {#if row.src === 'registry' && row.utility.credentials.length}
          <span class="flex items-center gap-1">
            <KeyRound size={11} />
            {row.utility.credentials.length}
            {row.utility.credentials.length === 1 ? 'credential' : 'credentials'}
          </span>
        {/if}
      </div>
      {#if isMcpRow(row)}
        {#if isComputerUseRow(row)}
          <p class="mt-2 text-[0.6875rem] text-dimmed">
            Started by each computer-use run, so Cua Driver settings report this connection.
          </p>
        {:else}
          <McpConnectionTester variant="row" subject={row.name} probe={() => mcpProbeTarget(row)} />
        {/if}
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      {#if row.src === 'registry' && canToggleUtilityEnabled(row.utility)}
        <Switch
          checked={row.enabled}
          onchange={() => void toggleEnabled(row)}
          aria-label="{row.enabled ? 'Disable' : 'Enable'} {row.name}"
          title="{row.enabled ? 'Disable' : 'Enable'} {row.name}"
        />
      {/if}
      {#if !row.appOwned || (row.src === 'registry' && canToggleUtilityEnabled(row.utility))}
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
          aria-label="Edit {row.name}"
          title="Edit {row.name}"
          onclick={() => openEdit(row)}
        >
          <Pencil size={14} />
        </button>
      {/if}
      {#if !row.appOwned}
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
          aria-label="Delete {row.name}"
          title="Delete {row.name}"
          onclick={() => (deleteTarget = row)}
        >
          <Trash2 size={14} />
        </button>
      {/if}
    </div>
  </div>
{/snippet}

<div class="p-6 pb-24">
  <!-- Header: what this page holds on the left, the page's own actions on the
       right, so the title never competes with navigation for one row. -->
  <div class="flex flex-wrap items-start justify-between gap-4">
    <div class="min-w-0">
      <h1 class="text-xl font-bold tracking-tight">Utilities</h1>
      <p class="mt-1 text-sm text-muted">{TAB_BLURB[activeTab]}</p>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover"
        title="Add a skill, MCP server, or other utility"
        onclick={openCreate}
      >
        <Plus size={13} /> Add utility
      </button>
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
        disabled={activeTab === 'tools'
          ? agentToolsStore.loading || agentToolsStore.refreshing
          : loading}
        title="Refresh utilities"
        onclick={refreshActiveTab}
      >
        <RefreshCw
          size={13}
          class={(
            activeTab === 'tools' ? agentToolsStore.loading || agentToolsStore.refreshing : loading
          )
            ? 'animate-spin'
            : ''}
        /> Refresh
      </button>
      {#if activeTab === 'all' || activeTab === 'skills' || activeTab === 'bookmarks'}
        <button
          class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          title="Open the skills marketplace"
          onclick={onOpenMarketplace}
        >
          <Search size={13} /> Skills marketplace
        </button>
        <button
          class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          title="Open the agent plugin marketplace"
          onclick={onOpenPluginMarketplace}
        >
          <Package size={13} /> Agent plugins
        </button>
      {/if}
    </div>
  </div>

  <!-- Section tabs on the left, installed-skill upkeep on the right. The two
       clusters share one row without competing: navigation stays in one piece,
       and the background check reads as page housekeeping, not page action. -->
  <div class="mt-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
    <div
      class="flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
      role="tablist"
      aria-label="Utilities sections"
    >
      {#each tabs as tab (tab.id)}
        <button
          class="rounded-md px-3 py-1.5 text-xs font-medium transition-colors {activeTab === tab.id
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          role="tab"
          aria-selected={activeTab === tab.id}
          title={TAB_TITLE[tab.id]}
          onclick={() => onSelectTab(tab.id)}
        >
          {tab.label}
        </button>
      {/each}
    </div>

    {#if showsSkillUpdates}
      <div class="flex min-w-0 items-center gap-2">
        <span
          class="truncate text-[0.6875rem] {skillUpdateState.status.error
            ? 'text-danger'
            : 'text-dimmed'}"
          title={SKILL_UPDATE_TOOLTIP}
        >
          {skillUpdateSummary}
        </span>
        <button
          type="button"
          class="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-[0.6875rem] font-medium hover:bg-overlay disabled:opacity-50"
          disabled={skillUpdateState.status.running}
          title="Check the skills installed by CodeInOven for updates now"
          onclick={() => void skillUpdateState.checkNow()}
        >
          <RefreshCw size={11} class={skillUpdateState.status.running ? 'animate-spin' : ''} /> Update
          utilities
        </button>
      </div>
    {/if}
  </div>

  {#if isListTab(activeTab)}
    <!-- Search and the entry count: one row, same place for every list tab. -->
    <div class="mt-4 flex items-center gap-3">
      <label class="relative block min-w-0 flex-1">
        <Search
          size={14}
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <span class="sr-only">
          Search {activeTab === 'bookmarks' ? 'bookmarked skills' : 'utilities'}
        </span>
        <input
          bind:this={searchInputEl}
          class="h-9 w-full rounded-lg border bg-elevated pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-dimmed focus:border-primary"
          type="text"
          placeholder={SEARCH_PLACEHOLDER[activeTab]}
          bind:value={query}
        />
        {#if query}
          <button
            type="button"
            class="absolute right-2 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
            onclick={clearSearch}
          >
            <X size={12} />
          </button>
        {/if}
      </label>
      <span class="flex shrink-0 items-baseline gap-1 whitespace-nowrap text-xs text-muted">
        <span class="font-medium tabular-nums text-foreground">{resultCount}</span>
        {activeTab === 'tools'
          ? resultCount === 1
            ? 'tool'
            : 'tools'
          : resultCount === 1
            ? 'entry'
            : 'entries'}
      </span>
    </div>

    <!-- Filters: what is shown (built-ins) first, then the scope and harness tags. -->
    <div class="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
      {#if activeTab === 'tools'}
        <select
          class="h-7 rounded-lg border bg-elevated px-2 text-[0.6875rem] font-medium outline-none focus:border-primary"
          aria-label="Filter tools by source"
          value={agentToolsStore.selectedSource}
          onchange={(event: Event) =>
            setToolSource((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="all">All sources</option>
          <option value="application">Application</option>
          <option value="harness">Harnesses</option>
        </select>
        {#if toolHarnesses.length && agentToolsStore.selectedSource !== 'application'}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {agentToolsStore.selectedHarness ===
            null
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={agentToolsStore.selectedHarness === null}
            onclick={() => (agentToolsStore.selectedHarness = null)}
          >
            All
            <span class="tabular-nums opacity-70">{toolGroups.length}</span>
          </button>
          {#each toolHarnesses as harness (harness.id)}
            <button
              type="button"
              class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {agentToolsStore.selectedHarness ===
              harness.id
                ? 'border-primary bg-primary text-on-primary'
                : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
              aria-pressed={agentToolsStore.selectedHarness === harness.id}
              title={harness.detail}
              onclick={() => (agentToolsStore.selectedHarness = harness.id)}
            >
              <AgentIcon agentId={harness.id} label={harness.name} size={14} />
              {harness.name}
              <span class="tabular-nums opacity-70">{toolHarnessGroupCount(harness.id)}</span>
            </button>
          {/each}
        {/if}
      {:else}
        {#if activeTab !== 'bookmarks' && builtInRowCount > 0}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {utilitiesViewPrefs.hideBuiltIn
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={utilitiesViewPrefs.hideBuiltIn}
            title={utilitiesViewPrefs.hideBuiltIn
              ? 'Show the utilities built into CodeInOven'
              : `Hide the ${builtInRowCount} ${builtInRowCount === 1 ? 'utility' : 'utilities'} built into CodeInOven`}
            onclick={() => utilitiesViewPrefs.setHideBuiltIn(!utilitiesViewPrefs.hideBuiltIn)}
          >
            Hide built-in
            <span class="tabular-nums opacity-70">{builtInRowCount}</span>
          </button>
        {/if}
        {#if activeTab !== 'bookmarks' && builtInRowCount > 0 && availableTags.length > 0}
          <span class="mx-0.5 h-4 w-px shrink-0 bg-border/60" aria-hidden="true"></span>
        {/if}
        {#if availableTags.length > 0 && activeTab !== 'bookmarks'}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {activeTagFilter ===
            'all'
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={activeTagFilter === 'all'}
            onclick={() => (scopeFilter = 'all')}
          >
            All
          </button>
          {#each availableTags as tag (tag)}
            <button
              type="button"
              class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[0.6875rem] font-medium transition-colors {activeTagFilter ===
              tag
                ? 'border-primary bg-primary text-on-primary'
                : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
              aria-pressed={activeTagFilter === tag}
              onclick={() => (scopeFilter = tag)}
            >
              {@render tagChip(tag)}
            </button>
          {/each}
        {/if}
      {/if}
    </div>
  {/if}

  <!-- Row 6 — tab content. -->
  <div class="mt-4">
    {#if activeTab === 'all' || activeTab === 'skills' || activeTab === 'bookmarks' || activeTab === 'mcp' || activeTab === 'web'}
      {#if (activeTab === 'all' || activeTab === 'skills' || activeTab === 'mcp') && !secureStorageAvailable}
        <div
          class="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <AlertTriangle size={14} class="mt-0.5 shrink-0" />
          <span>Secure storage is unavailable. Credentials cannot be saved on this device.</span>
        </div>
      {/if}
      {#if error}
        <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </p>
      {/if}

      {#if loading && tabRows.length === 0}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <Loader2 size={18} class="mx-auto mb-2 animate-spin text-dimmed" />
          <p class="text-xs text-dimmed">Loading…</p>
        </div>
      {:else if filteredRows.length === 0}
        <div class="rounded-xl border border-dashed p-8 text-center">
          {#if hiddenBuiltInCount > 0}
            <Package size={18} class="mx-auto mb-2 text-dimmed" />
            <p class="text-sm font-medium">Built-in utilities are hidden</p>
            <p class="mt-1 text-xs text-dimmed">
              Your filter hides {hiddenBuiltInCount} built-in
              {hiddenBuiltInCount === 1 ? 'utility' : 'utilities'} from this list.
            </p>
            <button
              class="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
              type="button"
              title="Show the utilities built into CodeInOven"
              onclick={() => utilitiesViewPrefs.setHideBuiltIn(false)}
            >
              Show built-in
            </button>
          {:else if activeTab === 'bookmarks'}
            <Bookmark size={18} class="mx-auto mb-2 text-dimmed" />
            <p class="text-sm font-medium">No bookmarked skills</p>
            <p class="mt-1 text-xs text-dimmed">
              Bookmark a skill in the marketplace to keep it one click away, without installing it.
            </p>
            <button
              class="mt-4 inline-flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
              type="button"
              title="Open the skills marketplace"
              onclick={onOpenMarketplace}
            >
              <Search size={13} /> Skills marketplace
            </button>
          {:else}
            <Puzzle size={18} class="mx-auto mb-2 text-dimmed" />
            <p class="text-sm font-medium">No matching entries</p>
            <p class="mt-1 text-xs text-dimmed">Add a utility or change the filters.</p>
          {/if}
        </div>
      {:else}
        <div class="space-y-5">
          {#each vendorGroups as group (group.vendor.id)}
            {@const folded = utilitiesViewPrefs.isVendorFolded(group.vendor.id)}
            <section aria-label={group.vendor.label}>
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-lg px-1 py-1.5 text-left transition-colors hover:bg-overlay"
                aria-expanded={!folded}
                aria-label="{folded ? 'Expand' : 'Fold'} {group.vendor.label}"
                title="{folded ? 'Expand' : 'Fold'} {group.vendor.label}"
                onclick={() => utilitiesViewPrefs.toggleVendorFold(group.vendor.id)}
              >
                <ChevronDown
                  size={12}
                  class="shrink-0 text-dimmed transition-transform {folded ? '-rotate-90' : ''}"
                  aria-hidden="true"
                />
                {#if group.vendor.kind === 'app'}
                  <img class="h-3.5 w-3.5 shrink-0 object-contain" src={cioIconUrl} alt="" />
                {:else if group.vendor.kind === 'harness'}
                  <AgentIcon
                    agentId={group.vendor.harnessId ?? group.vendor.id}
                    label={group.vendor.label}
                    size={14}
                  />
                {:else if group.vendor.kind === 'marketplace'}
                  <VendorIcon name={group.vendor.label} id={group.vendor.iconName} size={14} />
                {:else}
                  <Package size={13} class="shrink-0 text-dimmed" />
                {/if}
                <h2 class="text-xs font-semibold">{group.vendor.label}</h2>
                <span class="text-[0.6875rem] tabular-nums text-dimmed">{group.rows.length}</span>
                {#if group.vendor.source}
                  <span class="truncate font-mono text-[0.625rem] text-dimmed">
                    {group.vendor.source}
                  </span>
                {/if}
              </button>
              {#if !folded}
                <div class="divide-y rounded-xl border bg-surface">
                  {#each group.rows as row (row.id)}
                    {#if row.src === 'bookmark'}
                      {@render bookmarkRow(row)}
                    {:else}
                      {@render utilityRow(row)}
                    {/if}
                  {/each}
                </div>
              {/if}
            </section>
          {/each}
        </div>
      {/if}
    {:else if activeTab === 'plugins'}
      <div class="rounded-xl border bg-surface p-5">
        <div class="rounded-xl border border-dashed bg-elevated p-5">
          <Boxes size={20} class="mb-3 text-muted" />
          <p class="text-sm font-semibold">Import a plugin bundle</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            A plugin bundle can install several MCP servers, skills, and web utilities together.
            Installation is atomic: if one entry is invalid, nothing is added. The installed
            capabilities appear on their respective tabs.
          </p>
          <label
            class="mt-4 inline-flex h-9 cursor-pointer items-center rounded-lg border bg-surface px-3 text-xs font-medium hover:bg-overlay"
          >
            Choose JSON file
            <input
              class="sr-only"
              type="file"
              accept=".json,application/json"
              onchange={readPluginFile}
            />
          </label>
        </div>
        {#if error}
          <p class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {error}
          </p>
        {/if}
        <label class="mt-4 block space-y-1 text-xs font-medium">
          <span>Or paste the manifest</span>
          <textarea
            class="min-h-64 w-full resize-y rounded-xl border bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-primary"
            placeholder={'{\n  "name": "My plugin",\n  "utilities": [\n    { "definition": { ... }, "credentials": [] }\n  ]\n}'}
            bind:value={pluginManifest}></textarea>
        </label>
        <button
          class="mt-3 flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          disabled={!pluginManifest.trim()}
          onclick={() => void importPluginBundle()}
        >
          <Upload size={13} /> Install bundle
        </button>
      </div>
    {:else if activeTab === 'tools'}
      {#if agentToolsStore.catalog?.notices.length}
        <div class="mb-4 space-y-2">
          {#each agentToolsStore.catalog.notices as notice (notice)}
            <p class="rounded-lg border bg-elevated px-3 py-2 text-xs text-muted">
              {notice}
            </p>
          {/each}
        </div>
      {/if}
      {#if agentToolsStore.error}
        <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {agentToolsStore.error}
        </p>
      {/if}

      {#if agentToolsStore.loading && !agentToolsStore.catalog}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <RefreshCw size={18} class="mx-auto mb-2 animate-spin text-dimmed" />
          <p class="text-xs text-dimmed">Loading agent tools…</p>
        </div>
      {:else if filteredToolGroups.length}
        <div class="space-y-2">
          {#each filteredToolGroups as group (group.key)}
            {@const tool = group.definition}
            <details class="group rounded-xl border bg-surface">
              <summary
                class="flex cursor-pointer list-none items-start gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span
                  class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"
                >
                  <Wrench size={14} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-sm font-semibold">{tool.name}</span>
                    <span
                      class="rounded-md bg-elevated px-1.5 py-0.5 text-[0.625rem] font-medium uppercase tracking-wide text-muted"
                    >
                      {tool.source}
                    </span>
                    {#each group.harnessIds as harnessId (harnessId)}
                      <span
                        class="flex h-6 items-center gap-1.5 rounded-md border bg-elevated px-2 text-[0.625rem] font-medium text-muted"
                      >
                        <AgentIcon
                          agentId={harnessId}
                          label={toolHarnessName(harnessId)}
                          size={14}
                        />
                        {toolHarnessName(harnessId)}
                      </span>
                    {/each}
                  </span>
                  {#if tool.transportName}
                    <span class="mt-1 block text-[0.6875rem] text-dimmed">
                      Wire name: <span class="font-mono">{tool.transportName}</span>
                    </span>
                  {/if}
                  <span class="mt-1 block text-xs leading-relaxed text-muted">
                    {tool.description || 'No description supplied by the harness.'}
                  </span>
                  <span class="mt-1 block text-[0.6875rem] text-dimmed">
                    Sent when: {group.sentWhen.join(' · ')}
                  </span>
                </span>
              </summary>
              <div class="border-t p-4">
                <p class="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted">
                  Input / parameter schema
                </p>
                <pre
                  class="max-h-128 overflow-auto rounded-lg bg-raised p-3 font-mono text-[0.6875rem] leading-relaxed text-foreground"><code
                    >{schemaText(tool)}</code
                  ></pre>
              </div>
            </details>
          {/each}
        </div>
      {:else}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <Wrench size={18} class="mx-auto mb-2 text-dimmed" />
          <p class="text-sm font-medium">
            {selectedToolHarnessDetails?.status === 'unsupported' ||
            selectedToolHarnessDetails?.status === 'unavailable'
              ? `${selectedToolHarnessDetails.name} schemas unavailable`
              : 'No matching tools'}
          </p>
          <p class="mt-1 text-xs text-dimmed">
            {selectedToolHarnessDetails?.detail ??
              'Clear the search or open a configured thread to load harness tools.'}
          </p>
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if editorOpen}
  <UtilityEditorModal
    open
    target={editorTarget}
    skillCatalog={capabilities?.skill ?? []}
    onClose={() => (editorOpen = false)}
    onSaved={replaceUtility}
    onChanged={() => void load()}
  />
{/if}

{#if deleteTarget}
  <ConfirmDialog
    open
    title="Delete utility"
    onCancel={() => (deleteTarget = null)}
    onConfirm={confirmDelete}
    confirmLabel="Delete"
    busy={deleting}
  >
    <p>
      Delete <strong class="text-foreground">{deleteTarget.name}</strong>? Its files or registry
      entry will be removed.
    </p>
  </ConfirmDialog>
{/if}
