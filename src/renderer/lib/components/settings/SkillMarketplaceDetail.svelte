<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AppWindow,
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
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { cachedSkillMarketDetail, loadSkillMarketDetail } from '$lib/skill-market-cache'
  import { providerStore } from '$lib/stores/providers.svelte'
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
  type NativeDestination = NonNullable<SkillMarketInstallRequest['nativeTarget']>['kind']

  let { entry }: Props = $props()
  let detail = $state<SkillMarketDetail | null>(null)
  let loading = $state(true)
  let installing = $state(false)
  let error = $state('')
  let installedMessage = $state('')
  let manager = $state<InstallManager>('native')
  let scope = $state<InstallScope>('global')
  let activation = $state<UtilityActivation>('on_demand')
  let nativeDestination = $state<NativeDestination>('shared')
  let selectedProjectIds = $state<string[]>([])
  let selectedHarnessIds = $state<string[]>([])
  let projects = $state<ProjectMultiSelectOption[]>([])
  let availableHarnesses = $derived(
    providerStore.providers.filter((provider) => provider.status === 'available')
  )
  let selectionIncomplete = $derived(
    (scope === 'projects' && selectedProjectIds.length === 0) ||
      (manager === 'native' && nativeDestination === 'harnesses' && selectedHarnessIds.length === 0)
  )
  let destinationSummary = $derived.by(() => {
    const projectCount = selectedProjectIds.length
    const harnessCount = selectedHarnessIds.length
    if (manager === 'cio') {
      const availability = activation === 'always' ? 'always available' : 'loaded on demand'
      return scope === 'global'
        ? `${APP_NAME} utility · global · ${availability}`
        : `${APP_NAME} utility · ${projectCount || 'no'} project${projectCount === 1 ? '' : 's'} · ${availability}`
    }
    if (scope === 'global' && nativeDestination === 'shared') {
      return 'Global shared directory · ~/.agents/skills'
    }
    if (scope === 'global') {
      return `${harnessCount || 'No'} harness global director${harnessCount === 1 ? 'y' : 'ies'}`
    }
    if (nativeDestination === 'shared') {
      return `Shared .agents/skills directory in ${projectCount || 'no'} project${projectCount === 1 ? '' : 's'}`
    }
    return `${harnessCount || 'No'} harness director${harnessCount === 1 ? 'y' : 'ies'} in ${projectCount || 'no'} project${projectCount === 1 ? '' : 's'}`
  })

  function auditClass(status: SkillMarketDetail['audits'][number]['status']): string {
    if (status === 'pass') return 'bg-success/10 text-success'
    if (status === 'warn') return 'bg-warning/10 text-warning'
    if (status === 'fail') return 'bg-danger/10 text-danger'
    return 'bg-raised text-muted'
  }

  function toggleHarness(harnessId: string): void {
    selectedHarnessIds = selectedHarnessIds.includes(harnessId)
      ? selectedHarnessIds.filter((candidate) => candidate !== harnessId)
      : [...selectedHarnessIds, harnessId]
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
            : { kind: 'projects', projectIds: selectedProjectIds },
        ...(manager === 'cio'
          ? { activation }
          : {
              nativeTarget:
                nativeDestination === 'shared'
                  ? { kind: 'shared' }
                  : { kind: 'harnesses', harnessIds: selectedHarnessIds }
            })
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

    <aside class="order-first space-y-4 self-start lg:order-none" aria-label="Install skill and skill facts">
      <section class="rounded-xl border bg-surface p-4" aria-labelledby="install-skill-title">
        <h2 id="install-skill-title" class="text-sm font-semibold">Install skill</h2>
        <p class="mt-1 text-[11px] leading-relaxed text-muted">
          Choose who owns the skill and exactly where it should be available.
        </p>

        <div class="mt-4 grid grid-cols-2 gap-1 rounded-lg bg-elevated p-1">
          <button
            type="button"
            class="flex h-8 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors {manager ===
            'cio'
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={manager === 'cio'}
            onclick={() => (manager = 'cio')}
          >
            <AppWindow size={12} />
            {APP_NAME}
          </button>
          <button
            type="button"
            class="flex h-8 items-center justify-center gap-1.5 rounded-md text-[11px] font-medium transition-colors {manager ===
            'native'
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            aria-pressed={manager === 'native'}
            onclick={() => (manager = 'native')}
          >
            <SquareTerminal size={12} /> Native harnesses
          </button>
        </div>

        <div class="mt-4 space-y-2">
          <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Scope</p>
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              class="flex h-9 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors {scope ===
              'global'
                ? 'border-primary bg-primary/10 text-primary'
                : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
              aria-pressed={scope === 'global'}
              onclick={() => (scope = 'global')}
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
              onclick={() => (scope = 'projects')}
            >
              <FolderKanban size={13} /> Projects
            </button>
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
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Availability</p>
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
              <span class="ml-auto text-[10px] text-muted">Match by task</span>
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
              <span class="ml-auto text-[10px] text-muted">Every turn</span>
            </button>
          </div>
        {:else}
          <div class="mt-4 space-y-2">
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Directory</p>
            <button
              type="button"
              class="w-full rounded-lg border p-2.5 text-left transition-colors {nativeDestination ===
              'shared'
                ? 'border-primary bg-primary/10'
                : 'bg-elevated hover:bg-overlay'}"
              aria-pressed={nativeDestination === 'shared'}
              onclick={() => (nativeDestination = 'shared')}
            >
              <span class="block text-xs font-medium">Shared agents directory</span>
              <span class="mt-0.5 block font-mono text-[10px] text-muted">.agents/skills</span>
            </button>
            <button
              type="button"
              class="w-full rounded-lg border p-2.5 text-left transition-colors {nativeDestination ===
              'harnesses'
                ? 'border-primary bg-primary/10'
                : 'bg-elevated hover:bg-overlay'}"
              aria-pressed={nativeDestination === 'harnesses'}
              onclick={() => (nativeDestination = 'harnesses')}
            >
              <span class="block text-xs font-medium">Harness directories</span>
              <span class="mt-0.5 block text-[10px] text-muted">Pick one or more harnesses</span>
            </button>
            {#if nativeDestination === 'harnesses'}
              <div class="flex flex-wrap gap-1.5 pt-1">
                {#each availableHarnesses as harness (harness.id)}
                  <button
                    type="button"
                    class="flex h-8 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors {selectedHarnessIds.includes(
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
                  <p class="text-[10px] leading-relaxed text-dimmed">
                    No installed harnesses are available.
                  </p>
                {/if}
              </div>
            {/if}
          </div>
        {/if}

        <p class="mt-4 text-[10px] leading-relaxed text-dimmed">{destinationSummary}</p>
        <button
          class="mt-3 flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
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
            <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Installs</p>
            <p class="mt-1 font-mono text-lg font-semibold tabular-nums">
              {(detail?.installs ?? entry.installs).toLocaleString()}
            </p>
          </div>
          <div>
            <p
              class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted"
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
              class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted"
            >
              <CalendarDays size={11} /> First seen
            </p>
            <p class="mt-1 font-mono text-xs">{detail?.firstSeen ?? '—'}</p>
          </div>
          <div>
            <p
              class="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted"
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
            class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
          >
            <ShieldCheck size={12} /> Security audits
          </p>
          {#if detail?.audits.length}
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#each detail.audits as audit (audit.name)}
                <span
                  class="rounded-md px-1.5 py-1 text-[9px] font-semibold {auditClass(audit.status)}"
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
