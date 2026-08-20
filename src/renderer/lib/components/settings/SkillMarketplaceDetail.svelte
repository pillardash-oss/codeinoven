<script lang="ts">
  import { onMount } from 'svelte'
  import {
    CalendarDays,
    Download,
    ExternalLink,
    GitFork,
    Loader2,
    ShieldCheck,
    Star
  } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import type {
    SkillMarketDetail,
    SkillMarketEntry,
    SkillMarketInstallRequest
  } from '$shared/types'

  interface Props {
    entry: SkillMarketEntry
  }

  let { entry }: Props = $props()
  let detail = $state<SkillMarketDetail | null>(null)
  let loading = $state(true)
  let installing = $state(false)
  let error = $state('')
  let installedMessage = $state('')
  let installTarget = $state('global')
  let availableHarnesses = $derived(
    providerStore.providers.filter((provider) => provider.status === 'available')
  )

  function auditClass(status: SkillMarketDetail['audits'][number]['status']): string {
    if (status === 'pass') return 'bg-success/10 text-success'
    if (status === 'warn') return 'bg-warning/10 text-warning'
    if (status === 'fail') return 'bg-danger/10 text-danger'
    return 'bg-raised text-muted'
  }

  async function currentProjectId(): Promise<string | null> {
    const selected = workspaceState.activeProject?.id ?? workspaceState.selectedThread?.projectId
    if (selected) return selected
    return (
      (await invoke('project:list')).find((project) => project.path && !project.hidden)?.id ?? null
    )
  }

  function selectedTarget(): SkillMarketInstallRequest['target'] {
    if (installTarget === 'global') return { kind: 'global' }
    if (installTarget === 'project') return { kind: 'project' }
    return { kind: 'harness', harnessId: installTarget.slice('harness:'.length) }
  }

  async function installSkill(): Promise<void> {
    const projectId = await currentProjectId()
    if (!projectId) {
      error = 'Open a local project before installing a marketplace skill.'
      return
    }
    installing = true
    error = ''
    installedMessage = ''
    try {
      await invoke('utilities:installMarketSkill', {
        source: entry.source,
        skillId: entry.skillId,
        projectId,
        target: selectedTarget()
      })
      installedMessage = `${entry.name} was installed successfully.`
    } catch (installError) {
      error =
        installError instanceof Error ? installError.message : 'The skill could not be installed.'
    } finally {
      installing = false
    }
  }

  onMount(() => {
    void providerStore.init()
    void (async () => {
      try {
        detail = await invoke('utilities:getSkillMarketDetail', entry.id)
      } catch (loadError) {
        error = loadError instanceof Error ? loadError.message : 'The skill details could not load.'
      } finally {
        loading = false
      }
    })()
  })
</script>

<div class="mx-auto max-w-5xl p-6 pb-24">
  {#if loading}
    <div class="rounded-xl border border-dashed p-12 text-center">
      <Loader2 size={22} class="mx-auto animate-spin text-dimmed" />
      <p class="mt-2 text-xs text-dimmed">Loading skill details…</p>
    </div>
  {:else}
    <div class="flex flex-wrap items-start justify-between gap-5 border-b pb-6">
      <div class="min-w-0 max-w-2xl">
        <p class="font-mono text-xs text-muted">{entry.source}</p>
        <h1 class="mt-1 break-words text-xl font-bold tracking-tight">{entry.name}</h1>
        <p class="mt-3 text-sm leading-relaxed text-muted">
          {detail?.description || 'No marketplace summary is available for this skill.'}
        </p>
      </div>
      <div class="flex min-w-64 flex-col gap-2 rounded-xl border bg-surface p-3">
        <label class="space-y-1 text-[11px] font-semibold text-muted">
          <span>Install to</span>
          <select
            class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-xs font-medium text-foreground outline-none focus:border-primary"
            bind:value={installTarget}
          >
            <option value="global">Global · all harnesses</option>
            <option value="project">Current project · all harnesses</option>
            {#each availableHarnesses as harness (harness.id)}
              <option value="harness:{harness.id}">{harness.name} only</option>
            {/each}
          </select>
        </label>
        <button
          class="flex h-9 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          disabled={installing}
          onclick={() => void installSkill()}
        >
          {#if installing}<Loader2 size={13} class="animate-spin" />{:else}<Download
              size={13}
            />{/if}
          {installing ? 'Installing…' : 'Install skill'}
        </button>
      </div>
    </div>

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

    <div class="mt-6 grid gap-8 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <section class="min-w-0" aria-labelledby="skill-content-title">
        <h2
          id="skill-content-title"
          class="border-b pb-3 text-xs font-semibold uppercase tracking-wide text-muted"
        >
          SKILL.md
        </h2>
        {#if detail?.skillMarkdown}
          <MarkdownView text={detail.skillMarkdown} class="mt-5" />
        {:else}
          <div class="mt-4 rounded-xl border border-dashed p-6">
            <p class="text-sm font-medium">SKILL.md preview unavailable</p>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              The marketplace metadata loaded, but the source did not expose a readable skill file.
            </p>
          </div>
        {/if}
      </section>

      <aside class="divide-y self-start rounded-xl border bg-surface px-4" aria-label="Skill facts">
        <div class="py-4">
          <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Installs</p>
          <p class="mt-1 font-mono text-lg font-semibold tabular-nums">
            {(detail?.installs ?? entry.installs).toLocaleString()}
          </p>
        </div>
        <div class="py-4">
          <p
            class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
          >
            <GitFork size={12} /> Repository
          </p>
          {#if detail?.repositoryUrl}
            <button
              class="mt-1 flex max-w-full items-center gap-1.5 text-left font-mono text-xs text-foreground hover:underline"
              type="button"
              title="Open {entry.source} on GitHub"
              onclick={() => void openInBrowser(detail?.repositoryUrl ?? entry.url)}
            >
              <span class="truncate">{entry.source}</span><ExternalLink
                size={11}
                class="shrink-0"
              />
            </button>
          {:else}
            <p class="mt-1 break-all font-mono text-xs">{entry.source}</p>
          {/if}
        </div>
        <div class="py-4">
          <p
            class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
          >
            <Star size={12} /> GitHub stars
          </p>
          <p class="mt-1 font-mono text-sm tabular-nums">
            {detail?.githubStars === null || detail?.githubStars === undefined
              ? 'Unavailable'
              : detail.githubStars.toLocaleString()}
          </p>
        </div>
        <div class="py-4">
          <p
            class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
          >
            <CalendarDays size={12} /> First seen
          </p>
          <p class="mt-1 font-mono text-sm">{detail?.firstSeen ?? 'Unavailable'}</p>
        </div>
        <div class="py-4">
          <p
            class="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted"
          >
            <ShieldCheck size={12} /> Security audits
          </p>
          {#if detail?.audits.length}
            <div class="mt-2 space-y-2">
              {#each detail.audits as audit (audit.name)}
                <div class="flex items-center justify-between gap-2 text-xs">
                  <span class="truncate">{audit.name}</span>
                  <span
                    class="rounded-md px-1.5 py-0.5 text-[9px] font-semibold uppercase {auditClass(
                      audit.status
                    )}"
                  >
                    {audit.status}
                  </span>
                </div>
              {/each}
            </div>
          {:else}
            <p class="mt-1 text-xs text-dimmed">No audit results published.</p>
          {/if}
        </div>
        <div class="py-4">
          <button
            class="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-foreground"
            type="button"
            title="Open this skill on skills.sh"
            onclick={() => void openInBrowser(entry.url)}
          >
            View on skills.sh <ExternalLink size={12} />
          </button>
        </div>
      </aside>
    </div>
  {/if}
</div>
