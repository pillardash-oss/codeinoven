<script lang="ts">
  import { onMount } from 'svelte'
  import {
    CalendarDays,
    Download,
    ExternalLink,
    FolderKanban,
    GitFork,
    Globe2,
    Loader2,
    ShieldCheck,
    SquareTerminal,
    Star
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { invoke } from '$lib/ipc.svelte'
  import {
    harnessGlobalSkillPath,
    SHARED_GLOBAL_SKILL_PATH,
    SHARED_PROJECT_SKILL_PATH
  } from '$shared/native-skill-paths'
  import { openInBrowser } from '$lib/open-in-browser'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { cachedSkillMarketDetail, loadSkillMarketDetail } from '$lib/skill-market-cache'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ProjectMultiSelect from '../shared/ProjectMultiSelect.svelte'
  import type { ProjectMultiSelectOption } from '../shared/ProjectMultiSelect.svelte'
  import type {
    Project,
    SkillMarketDetail,
    SkillMarketEntry,
    SkillMarketInstallRequest,
    UtilityActivation
  } from '$shared/types'
  import { APP_NAME } from '$shared/brand'

  interface Props {
    entry: SkillMarketEntry
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

  let { entry }: Props = $props()
  let detail = $state<SkillMarketDetail | null>(null)
  let loading = $state(true)
  let installing = $state(false)
  let error = $state('')
  let installedMessage = $state('')
  let manager = $state<InstallManager>('native')
  let scope = $state<InstallScope>('global')
  let activation = $state<UtilityActivation>('on_demand')
  let selectedProjectIds = $state<string[]>([])
  let selectedHarnessIds = $state<string[]>([])
  let projects = $state<ProjectMultiSelectOption[]>([])
  let cachedProviders = $derived(providerCatalog.allCached())
  let availableHarnesses = $derived.by((): HarnessOption[] => {
    const harnessNames: Record<string, string> = {}

    for (const provider of cachedProviders) {
      if (!provider.harnessId || providerStore.isUnsupported(provider.harnessId)) continue
      harnessNames[provider.harnessId] =
        getAgentIcon(provider.harnessId)?.name ?? provider.harnessId
    }

    for (const provider of providerStore.providers) {
      if (provider.status !== 'available' || providerStore.isUnsupported(provider.id)) continue
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
            path: `${project.path.replace(/\/+$/u, '')}/${SHARED_PROJECT_SKILL_PATH}`
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
      installedMessage = `${entry.name} installed successfully · ${destinationSummary}`
    } catch (installError) {
      error =
        installError instanceof Error ? installError.message : 'The skill could not be installed.'
    } finally {
      installing = false
    }
  }

  onMount(() => {
    const cachedDetail = cachedSkillMarketDetail(entry.id)
    if (cachedDetail) {
      detail = cachedDetail
      loading = false
    }
    void providerStore.init()
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

<div class="mx-auto max-w-5xl p-6 pb-24">
  <header class="max-w-3xl">
    <p class="font-mono text-xs text-muted">{entry.source}</p>
    <h1 class="mt-1 break-words text-xl font-bold tracking-tight">{entry.name}</h1>
    <p class="mt-3 text-sm leading-relaxed text-muted">
      {detail?.description ||
        (loading
          ? 'Loading source details…'
          : 'No marketplace summary is available for this skill.')}
    </p>
  </header>

  {#if error}
    <p class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {error}
    </p>
  {/if}
  {#if installedMessage}
    <p class="mt-4 rounded-lg bg-success/10 px-3 py-2 text-xs text-success" role="status">
      {installedMessage}
    </p>
  {/if}

  <div class="mt-7 grid gap-8 lg:grid-cols-[minmax(0,1fr)_19rem]">
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

    <aside
      class="order-first space-y-4 self-start lg:order-none"
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
            <VendorIcon name={APP_NAME} size={16} />
            {APP_NAME}
          </button>
          <button
            type="button"
            class="flex h-8 items-center justify-center gap-1.5 rounded-md text-[0.6875rem] font-medium transition-colors {manager ===
            'native'
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={manager === 'native'}
            onclick={() => selectManager('native')}
          >
            <SquareTerminal size={12} /> Native harnesses
          </button>
        </div>

        {#if manager === 'native'}
          <div class="mt-4 min-w-0 space-y-2">
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Skills path</p>
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
          <div class="grid gap-2 {manager === 'native' ? 'grid-cols-3' : 'grid-cols-2'}">
            <button
              type="button"
              class="flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors {scope ===
              'global'
                ? 'border-primary bg-primary/10 text-primary'
                : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
              aria-pressed={scope === 'global'}
              onclick={() => selectScope('global')}
            >
              <Globe2 size={13} /> Global
            </button>
            <button
              type="button"
              class="flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors {scope ===
              'projects'
                ? 'border-primary bg-primary/10 text-primary'
                : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
              aria-pressed={scope === 'projects'}
              onclick={() => selectScope('projects')}
            >
              <FolderKanban size={13} /> Projects
            </button>
            {#if manager === 'native'}
              <button
                type="button"
                class="flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors {scope ===
                'harnesses'
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
                aria-pressed={scope === 'harnesses'}
                onclick={() => selectScope('harnesses')}
              >
                <SquareTerminal size={13} /> Harnesses
              </button>
            {/if}
          </div>
          {#if scope === 'projects'}
            <ProjectMultiSelect
              {projects}
              values={selectedProjectIds}
              onValuesChange={(projectIds) => (selectedProjectIds = projectIds)}
              disabled={installing}
            />
          {/if}
        </div>

        {#if manager === 'cio'}
          <div class="mt-4 space-y-2">
            <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted">Availability</p>
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
          disabled={installing || selectionIncomplete}
          onclick={() => void installSkill()}
        >
          {#if installing}<Loader2 size={13} class="animate-spin" />{:else}<Download
              size={13}
            />{/if}
          {installing ? 'Installing…' : 'Install skill'}
        </button>
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
                ? '—'
                : detail.githubStars.toLocaleString()}
            </p>
          </div>
          <div>
            <p
              class="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
            >
              <CalendarDays size={11} /> First seen
            </p>
            <p class="mt-1 font-mono text-xs">{detail?.firstSeen ?? '—'}</p>
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
                  class="rounded-md px-1.5 py-1 text-[0.5625rem] font-semibold {auditClass(audit.status)}"
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
          onclick={() => void openInBrowser(entry.url)}
        >
          View on skills.sh <ExternalLink size={12} />
        </button>
      </section>
    </aside>
  </div>
</div>
