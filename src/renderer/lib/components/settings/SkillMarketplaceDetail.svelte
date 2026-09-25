<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ArrowLeft,
    CalendarDays,
    Check,
    Download,
    ExternalLink,
    FolderKanban,
    GitFork,
    Globe2,
    Loader2,
    ShieldCheck,
    SquareTerminal,
    Star,
    Trash2
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { invoke } from '$lib/ipc.svelte'
  import { publicAssetUrl } from '$lib/static-assets'
  import { installedSkillState } from '$lib/stores/installed-skills.svelte'
  import { skillUpdateState } from '$lib/stores/skill-updates.svelte'
  import {
    harnessGlobalSkillPath,
    SHARED_GLOBAL_SKILL_PATH,
    SHARED_PROJECT_SKILL_PATH
  } from '$shared/native-skill-paths'
  import { openInBrowser } from '$lib/open-in-browser'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { cachedSkillMarketDetail, loadSkillMarketDetail } from '$lib/skill-market-cache'
  import { skillBookmarkState, skillBookmarkTitle } from '$lib/stores/skill-bookmarks.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ProjectSwitch from '../shared/ProjectSwitch.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import SkillBookmarkButton from './SkillBookmarkButton.svelte'
  import SkillInstalledBadge from './SkillInstalledBadge.svelte'
  import type { ScopeProject } from '$lib/stores/scope.svelte'
  import type {
    Project,
    SkillMarketDetail,
    SkillMarketEntry,
    SkillMarketInstallRequest,
    UtilityActivation
  } from '$shared/types'
  import { APP_NAME } from '$shared/brand'
  import { toPosixPath } from '$shared/paths'

  interface Props {
    entry: SkillMarketEntry
    /** Where the back control returns to; doubles as its accessible description. */
    backLabel: string
    onBack: () => void
  }

  type InstallManager = SkillMarketInstallRequest['manager']
  type InstallScope = SkillMarketInstallRequest['scope']['kind']

  interface HarnessOption {
    id: string
    name: string
  }

  interface SkillPathOption {
    id: string
    label: string
    path: string
  }

  let { entry, backLabel, onBack }: Props = $props()
  const cioIconUrl = publicAssetUrl('icon.svg')
  let detail = $state<SkillMarketDetail | null>(null)
  let loading = $state(true)
  let installing = $state(false)
  let uninstalling = $state(false)
  let confirmingUninstall = $state(false)
  let error = $state('')
  let installedMessage = $state('')
  let manager = $state<InstallManager>('native')
  let scope = $state<InstallScope>('global')
  let activation = $state<UtilityActivation>('on_demand')
  let selectedProjectIds = $state<string[]>([])
  let selectedHarnessIds = $state<string[]>([])
  let projects = $state<ScopeProject[]>([])
  let cachedProviders = $derived(providerCatalog.allCached())
  let availableHarnesses = $derived.by((): HarnessOption[] => {
    const harnessNames: Record<string, string> = {}

    for (const provider of cachedProviders) {
      if (!provider.harnessId) continue
      harnessNames[provider.harnessId] =
        getAgentIcon(provider.harnessId)?.name ?? provider.harnessId
    }

    for (const provider of providerStore.providers) {
      if (provider.status !== 'available') continue
      harnessNames[provider.id] = getAgentIcon(provider.id)?.name ?? provider.name
    }

    return Object.entries(harnessNames)
      .filter(([id]) => harnessGlobalSkillPath(id) !== undefined)
      .map(([id, name]) => ({ id, name }))
      .sort((left, right) => {
        const leftIndex = providerStore.providers.findIndex((provider) => provider.id === left.id)
        const rightIndex = providerStore.providers.findIndex((provider) => provider.id === right.id)
        if (leftIndex !== rightIndex) {
          if (leftIndex < 0) return 1
          if (rightIndex < 0) return -1
          return leftIndex - rightIndex
        }
        return left.name.localeCompare(right.name)
      })
  })
  let selectionIncomplete = $derived(
    (scope === 'projects' && selectedProjectIds.length === 0) ||
      (scope === 'harnesses' && selectedHarnessIds.length === 0)
  )
  let skillPaths = $derived.by((): SkillPathOption[] => {
    if (manager !== 'native') return []
    if (scope === 'global') {
      return [{ id: 'global', label: 'All harnesses', path: SHARED_GLOBAL_SKILL_PATH }]
    }
    if (scope === 'projects') {
      return selectedProjectIds.flatMap((projectId) => {
        const project = projects.find((candidate) => candidate.id === projectId)
        if (!project?.path) return []
        return [
          {
            id: project.id,
            label: project.name,
            path: `${toPosixPath(project.path).replace(/\/+$/u, '')}/${SHARED_PROJECT_SKILL_PATH}`
          }
        ]
      })
    }
    return selectedHarnessIds.flatMap((harnessId) => {
      const harness = availableHarnesses.find((candidate) => candidate.id === harnessId)
      const path = harnessGlobalSkillPath(harnessId)
      return harness && path ? [{ id: harness.id, label: harness.name, path }] : []
    })
  })
  let destinationSummary = $derived.by(() => {
    const projectCount = selectedProjectIds.length
    const harnessCount = selectedHarnessIds.length
    if (manager === 'cio') {
      const availability = activation === 'always' ? 'always available' : 'loaded on demand'
      return scope === 'global'
        ? `${APP_NAME} utility · global · ${availability}`
        : `${APP_NAME} utility · ${projectCount || 'no'} project${projectCount === 1 ? '' : 's'} · ${availability}`
    }
    if (scope === 'global') return `All harnesses · ${SHARED_GLOBAL_SKILL_PATH}`
    if (scope === 'projects') {
      return `${projectCount || 'No'} project${projectCount === 1 ? '' : 's'} · ${SHARED_PROJECT_SKILL_PATH}`
    }
    return `${harnessCount || 'No'} harness${harnessCount === 1 ? '' : 'es'} selected`
  })

  /** Every place this skill is already installed, newest read first. */
  let installedLocations = $derived(installedSkillState.locationsFor(entry.skillId))

  /**
   * True when the owner and scope on screen is already covered by an installed
   * copy. Installing the same skill into another project or harness stays
   * possible, which a plain "is it installed anywhere" check would block.
   */
  let selectionInstalled = $derived.by(() => {
    if (installedLocations.length === 0) return false
    if (manager === 'cio') {
      // Activation is part of the request, so switching between on-demand and
      // always-available has to keep the install action available.
      const managed = installedLocations.filter(
        (location) => location.manager === 'cio' && location.activation === activation
      )
      if (scope === 'global') return managed.some((location) => location.scope === 'global')
      if (selectedProjectIds.length === 0) return false
      return selectedProjectIds.every((projectId) =>
        managed.some((location) => location.scope === 'project' && location.projectId === projectId)
      )
    }
    const native = installedLocations.filter((location) => location.manager === 'native')
    if (scope === 'global') return native.some((location) => location.scope === 'global')
    if (scope === 'projects') {
      if (selectedProjectIds.length === 0) return false
      return selectedProjectIds.every((projectId) =>
        native.some((location) => location.scope === 'project' && location.projectId === projectId)
      )
    }
    if (selectedHarnessIds.length === 0) return false
    return selectedHarnessIds.every((harnessId) =>
      native.some(
        (location) =>
          (location.scope === 'harness' && location.harnessId === harnessId) ||
          // A harness that shares the canonical skills folder is covered by the
          // shared global copy, which is exactly where its install lands.
          (location.scope === 'global' &&
            harnessGlobalSkillPath(harnessId) === SHARED_GLOBAL_SKILL_PATH)
      )
    )
  })

  function auditClass(status: SkillMarketDetail['audits'][number]['status']): string {
    if (status === 'pass') return 'bg-success/10 text-success'
    if (status === 'warn') return 'bg-warning/10 text-warning'
    if (status === 'fail') return 'bg-danger/10 text-danger'
    return 'bg-raised text-muted'
  }

  function toggleHarness(harnessId: string): void {
    const nextHarnessIds = selectedHarnessIds.includes(harnessId)
      ? selectedHarnessIds.filter((candidate) => candidate !== harnessId)
      : [...selectedHarnessIds, harnessId]
    if (availableHarnesses.length > 0 && nextHarnessIds.length === availableHarnesses.length) {
      selectedHarnessIds = []
      scope = 'global'
      return
    }
    selectedHarnessIds = nextHarnessIds
  }

  function selectManager(nextManager: InstallManager): void {
    manager = nextManager
    if (nextManager === 'cio' && scope === 'harnesses') {
      scope = 'global'
      selectedHarnessIds = []
    }
  }

  function selectScope(nextScope: InstallScope): void {
    scope = nextScope
    if (nextScope !== 'harnesses') selectedHarnessIds = []
  }

  async function loadProjects(): Promise<void> {
    const localProjects = (await invoke('project:list')).filter(
      (project): project is Project =>
        !project.hidden && project.source === 'local' && !!project.path
    )
    const iconUrls = Object.fromEntries(await loadProjectIcons(localProjects))
    projects = localProjects.map((project) => ({
      id: project.id,
      name: project.name,
      path: project.path,
      host: project.host,
      iconUrl: getProjectIcon(project, iconUrls[project.id]),
      color: project.color
    }))
  }

  async function installSkill(): Promise<void> {
    installing = true
    error = ''
    installedMessage = ''
    try {
      const request: SkillMarketInstallRequest = {
        source: entry.source,
        skillId: entry.skillId,
        manager,
        scope:
          scope === 'global'
            ? { kind: 'global' }
            : scope === 'projects'
              ? { kind: 'projects', projectIds: selectedProjectIds }
              : { kind: 'harnesses', harnessIds: selectedHarnessIds },
        ...(manager === 'cio' ? { activation } : {})
      }
      await invoke('utilities:installMarketSkill', request)
      // The install changed the registry and the skill folders on disk, so the
      // shared installed-state read is refreshed before the button flips over.
      await installedSkillState.refresh()
      // The install record is what the background updater owns, so its count is
      // re-read here too.
      void skillUpdateState.refresh()
      installedMessage = `${entry.name} installed.`
    } catch (installError) {
      error =
        installError instanceof Error ? installError.message : 'The skill could not be installed.'
    } finally {
      installing = false
    }
  }

  /**
   * Removes the skill from every place it was installed: main drops all the
   * CodeInOven entries that manage it and hands the native copies to the Skills
   * CLI, so one action clears global, harness, and project copies alike.
   */
  async function uninstallSkill(): Promise<void> {
    uninstalling = true
    error = ''
    installedMessage = ''
    try {
      await invoke('utilities:uninstallMarketSkill', entry.skillId)
      await installedSkillState.refresh()
      void skillUpdateState.refresh()
      installedMessage = `${entry.name} uninstalled.`
    } catch (uninstallError) {
      error =
        uninstallError instanceof Error
          ? uninstallError.message
          : 'The skill could not be uninstalled.'
    } finally {
      uninstalling = false
      confirmingUninstall = false
    }
  }

  onMount(() => {
    const cachedDetail = cachedSkillMarketDetail(entry.id)
    if (cachedDetail) {
      detail = cachedDetail
      loading = false
    }
    void providerStore.init()
    void installedSkillState.ensureLoaded()
    void loadProjects().catch((projectError) => {
      error = projectError instanceof Error ? projectError.message : 'Projects could not load.'
    })
    void loadSkillMarketDetail(entry.id)
      .then((loadedDetail) => {
        detail = loadedDetail
      })
      .catch((loadError) => {
        error = loadError instanceof Error ? loadError.message : 'The skill details could not load.'
      })
      .finally(() => {
        loading = false
      })
  })
</script>

<!--
  One scope destination per row: they are independent choices, so a shared row
  made them read as one segmented selector.
-->
{#snippet scopeOption(id: InstallScope, label: string, Icon: typeof Globe2)}
  <button
    type="button"
    class="flex h-9 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors {scope ===
    id
      ? 'border-primary bg-primary/10 text-primary'
      : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
    aria-pressed={scope === id}
    onclick={() => selectScope(id)}
  >
    <Icon size={13} />
    {label}
  </button>
{/snippet}

<div class="flex h-full min-h-0 flex-col">
  <!--
    The skill identity stays pinned while the body scrolls, so the back control,
    the bookmark toggle, and the summary never leave the screen.
  -->
  <header class="shrink-0 border-b bg-app px-6 pt-6 pb-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
        type="button"
        title={backLabel}
        onclick={onBack}
      >
        <ArrowLeft size={13} />
        {backLabel}
      </button>
      <SkillBookmarkButton
        {entry}
        labelled
        title={skillBookmarkTitle(entry.name, skillBookmarkState.isBookmarked(entry.id))}
        class="border bg-elevated hover:bg-overlay"
      />
    </div>

    <p class="mt-4 font-mono text-xs text-muted">{entry.source}</p>
    <h1 class="mt-1 flex flex-wrap items-center gap-2 text-xl font-bold tracking-tight">
      <span class="break-words">{entry.name}</span>
      {#if installedLocations.length > 0}<SkillInstalledBadge />{/if}
    </h1>
    <p class="mt-2 text-sm leading-relaxed text-muted">
      {detail?.description ||
        (loading
          ? 'Loading source details…'
          : 'No marketplace summary is available for this skill.')}
    </p>
  </header>

  <!--
    Phones get one scroller over the whole body. On wide screens the body scrolls
    on its own and the install card sits in a fixed pane beside it.
  -->
  <div
    class="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-24 lg:flex-row lg:gap-8 lg:overflow-hidden lg:p-0"
  >
    <div class="min-w-0 pt-4 lg:flex-1 lg:overflow-y-auto lg:px-6 lg:pt-5 lg:pb-24">
      {#if error}
        <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </p>
      {/if}
      {#if installedMessage}
        <p class="mb-4 rounded-lg bg-success/10 px-3 py-2 text-xs text-success" role="status">
          {installedMessage}
        </p>
      {/if}

      <section class="min-w-0" aria-labelledby="skill-content-title">
        <div class="flex items-center gap-2">
          <h2
            id="skill-content-title"
            class="text-xs font-semibold uppercase tracking-wide text-muted"
          >
            SKILL.md
          </h2>
          {#if loading}<Loader2 size={12} class="animate-spin text-dimmed" />{/if}
        </div>
        {#if detail?.skillMarkdown}
          <MarkdownView text={detail.skillMarkdown} class="mt-4" />
        {:else if loading}
          <div class="mt-5 space-y-3" aria-label="Loading skill instructions">
            <div class="h-4 w-3/5 animate-pulse rounded bg-raised"></div>
            <div class="h-3 w-full animate-pulse rounded bg-raised"></div>
            <div class="h-3 w-11/12 animate-pulse rounded bg-raised"></div>
            <div class="h-3 w-4/5 animate-pulse rounded bg-raised"></div>
          </div>
        {:else}
          <div class="mt-4 rounded-xl border border-dashed p-6">
            <p class="text-sm font-medium">SKILL.md preview unavailable</p>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              The marketplace metadata loaded, but the source did not expose a readable skill file.
            </p>
          </div>
        {/if}
      </section>
    </div>

    <aside
      class="order-first space-y-4 lg:order-none lg:w-[19rem] lg:shrink-0 lg:overflow-y-auto lg:py-5 lg:pr-6"
      aria-label="Install skill and skill facts"
    >
      <section class="rounded-xl border bg-surface p-4" aria-labelledby="install-skill-title">
        <h2 id="install-skill-title" class="text-sm font-semibold">Install skill</h2>
        <p class="mt-1 text-[0.6875rem] leading-relaxed text-muted">
          Choose who owns the skill and exactly where it should be available.
        </p>

        <div class="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-elevated p-1">
          <button
            type="button"
            class="flex h-8 items-center justify-center gap-1.5 rounded-md text-[0.6875rem] font-medium transition-colors {manager ===
            'cio'
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={manager === 'cio'}
            onclick={() => selectManager('cio')}
          >
            <!-- The same mark the utilities page pairs with its "CIO" scope tag. -->
            <img class="h-4 w-4 shrink-0 object-contain" src={cioIconUrl} alt="" />
            <span class="truncate">{APP_NAME}</span>
          </button>
          <button
            type="button"
            class="flex h-8 items-center justify-center gap-1.5 rounded-md text-[0.6875rem] font-medium whitespace-nowrap transition-colors {manager ===
            'native'
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={manager === 'native'}
            onclick={() => selectManager('native')}
          >
            <SquareTerminal size={12} /> Harnesses
          </button>
        </div>

        {#if manager === 'native'}
          <div class="mt-4 min-w-0 space-y-2">
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
              Skills path
            </p>
            {#if skillPaths.length > 0}
              <div
                class="grid max-h-[4.25rem] grid-flow-col grid-rows-2 justify-start gap-1.5 overflow-x-auto pb-1"
                aria-label="Selected skill installation paths"
              >
                {#each skillPaths as skillPath (skillPath.id)}
                  <span
                    class="flex h-8 max-w-72 shrink-0 items-center gap-2 rounded-lg bg-elevated px-2.5"
                  >
                    <span class="shrink-0 text-[0.625rem] font-medium text-muted">
                      {skillPath.label}
                    </span>
                    <span class="truncate font-mono text-[0.625rem] text-foreground">
                      {skillPath.path}
                    </span>
                  </span>
                {/each}
              </div>
            {:else}
              <p class="h-8 content-center text-[0.625rem] text-dimmed">
                {scope === 'projects'
                  ? 'Select one or more projects.'
                  : 'Select one or more harnesses.'}
              </p>
            {/if}
          </div>
        {/if}

        <div class="mt-4 space-y-2">
          <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Scope</p>
          <!-- One destination per row: each scope is a separate decision, and
               side-by-side chips read as one shared choice. -->
          <div class="grid gap-2">
            {@render scopeOption('global', 'Global', Globe2)}
            {@render scopeOption('projects', 'Projects', FolderKanban)}
            {#if manager === 'native'}
              {@render scopeOption('harnesses', 'Harnesses', SquareTerminal)}
            {/if}
          </div>
          {#if scope === 'projects'}
            <ProjectSwitch
              multiSelect
              {projects}
              selectedIds={selectedProjectIds}
              onSelectionChange={(projectIds) => (selectedProjectIds = projectIds)}
              allLabel="Select projects"
              ariaLabel="Select projects"
              disabled={installing}
            />
          {/if}
        </div>

        {#if manager === 'cio'}
          <div class="mt-4 space-y-2">
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
              Availability
            </p>
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-lg border p-2.5 text-left transition-colors {activation ===
              'on_demand'
                ? 'border-primary bg-primary/10'
                : 'bg-elevated hover:bg-overlay'}"
              aria-pressed={activation === 'on_demand'}
              onclick={() => (activation = 'on_demand')}
            >
              <span class="text-xs font-medium">On demand</span>
              <span class="ml-auto text-[0.625rem] text-muted">Match by task</span>
            </button>
            <button
              type="button"
              class="flex w-full items-start gap-2 rounded-lg border p-2.5 text-left transition-colors {activation ===
              'always'
                ? 'border-primary bg-primary/10'
                : 'bg-elevated hover:bg-overlay'}"
              aria-pressed={activation === 'always'}
              onclick={() => (activation = 'always')}
            >
              <span class="text-xs font-medium">Always available</span>
              <span class="ml-auto text-[0.625rem] text-muted">Every turn</span>
            </button>
          </div>
        {:else if scope === 'harnesses'}
          <div class="mt-4 min-w-0 space-y-2">
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">
              Select harnesses
            </p>
            <div
              class="grid max-h-[4.25rem] grid-flow-col grid-rows-2 justify-start gap-1.5 overflow-x-auto pb-1"
            >
              {#each availableHarnesses as harness (harness.id)}
                <button
                  type="button"
                  class="flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[0.6875rem] font-medium transition-colors {selectedHarnessIds.includes(
                    harness.id
                  )
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
                  aria-pressed={selectedHarnessIds.includes(harness.id)}
                  onclick={() => toggleHarness(harness.id)}
                >
                  <AgentIcon agentId={harness.id} label={harness.name} size={14} />
                  {harness.name}
                </button>
              {/each}
              {#if availableHarnesses.length === 0}
                <p class="text-[0.625rem] leading-relaxed text-dimmed">
                  No installed harnesses are available.
                </p>
              {/if}
            </div>
          </div>
        {/if}

        {#if manager === 'cio'}
          <p class="mt-4 text-[0.625rem] leading-relaxed text-dimmed">{destinationSummary}</p>
        {/if}
        <button
          class="flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50 {manager ===
          'cio'
            ? 'mt-3'
            : 'mt-4'}"
          type="button"
          disabled={installing || selectionInstalled || selectionIncomplete}
          onclick={() => void installSkill()}
        >
          {#if installing}<Loader2 size={13} class="animate-spin" />{:else if selectionInstalled}
            <Check size={13} />{:else}<Download size={13} />{/if}
          {installing ? 'Installing…' : selectionInstalled ? 'Installed' : 'Install skill'}
        </button>

        {#if installedLocations.length > 0}
          <button
            class="mt-2 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border border-danger/40 px-4 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
            type="button"
            disabled={uninstalling}
            onclick={() => (confirmingUninstall = true)}
          >
            {#if uninstalling}<Loader2 size={13} class="animate-spin" />{:else}<Trash2
                size={13}
              />{/if}
            {uninstalling ? 'Uninstalling…' : 'Uninstall'}
          </button>
        {/if}
      </section>

      <section class="rounded-xl border bg-surface p-4" aria-label="Skill facts">
        <div class="grid grid-cols-2 gap-x-4 gap-y-5">
          <div>
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Installs</p>
            <p class="mt-1 font-mono text-lg font-semibold tabular-nums">
              {(detail?.installs ?? entry.installs).toLocaleString()}
            </p>
          </div>
          <div>
            <p
              class="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
            >
              <Star size={11} /> Stars
            </p>
            <p class="mt-1 font-mono text-sm tabular-nums">
              {detail?.githubStars === null || detail?.githubStars === undefined
                ? ' '
                : detail.githubStars.toLocaleString()}
            </p>
          </div>
          <div>
            <p
              class="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
            >
              <CalendarDays size={11} /> First seen
            </p>
            <p class="mt-1 font-mono text-xs">{detail?.firstSeen ?? ' '}</p>
          </div>
          <div>
            <p
              class="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
            >
              <GitFork size={11} /> Repository
            </p>
            <button
              class="mt-1 flex max-w-full items-center gap-1 text-left font-mono text-xs hover:underline"
              type="button"
              title="Open {entry.source} on GitHub"
              data-external-url={detail?.repositoryUrl ?? entry.url}
              onclick={() => void openInBrowser(detail?.repositoryUrl ?? entry.url)}
            >
              <span class="truncate">{entry.source}</span><ExternalLink
                size={10}
                class="shrink-0"
              />
            </button>
          </div>
        </div>

        <div class="mt-5">
          <p
            class="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
          >
            <ShieldCheck size={12} /> Security audits
          </p>
          {#if detail?.audits.length}
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#each detail.audits as audit (audit.name)}
                <span
                  class="rounded-md px-1.5 py-1 text-[0.5625rem] font-semibold {auditClass(
                    audit.status
                  )}"
                >
                  {audit.name} · {audit.status}
                </span>
              {/each}
            </div>
          {:else}
            <p class="mt-1 text-xs text-dimmed">
              {loading ? 'Loading audit signals…' : 'No audit results published.'}
            </p>
          {/if}
        </div>

        <button
          class="mt-5 flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
          type="button"
          title="Open this skill on skills.sh"
          data-external-url={entry.url}
          onclick={() => void openInBrowser(entry.url)}
        >
          View on skills.sh <ExternalLink size={12} />
        </button>
      </section>
    </aside>
  </div>
</div>

<ConfirmDialog
  open={confirmingUninstall}
  title="Uninstall skill"
  confirmLabel="Uninstall"
  note="This cannot be undone."
  busy={uninstalling}
  onCancel={() => (confirmingUninstall = false)}
  onConfirm={uninstallSkill}
>
  <p>
    Remove <strong class="text-foreground">{entry.name}</strong> from every place it is installed?
  </p>
  <p class="mt-2">
    This deletes the skill files on disk and every {APP_NAME} entry that manages it.
  </p>
</ConfirmDialog>
