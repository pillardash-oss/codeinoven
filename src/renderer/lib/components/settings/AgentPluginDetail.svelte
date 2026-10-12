<script lang="ts">
  import {
    invalidateAgentPluginMarket,
    loadAgentPluginDetail,
    loadAgentPluginIcon,
    refreshInstalledAgentPlugins
  } from '$lib/agent-plugin-cache'
  import { invoke } from '$lib/ipc.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { pluginInitials } from '$lib/plugin-identity'
  import type {
    AgentPluginDetail,
    AgentPluginMarketEntry,
    InstalledAgentPlugin
  } from '$shared/types'
  import {
    ArrowLeft,
    Bookmark,
    BookOpen,
    Download,
    ExternalLink,
    Loader2,
    RefreshCw,
    Server,
    Sparkles,
    Trash2,
    TriangleAlert
  } from '@lucide/svelte'
  import { onMount } from 'svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'

  interface Props {
    pluginId: string
    /** Where the back control returns to; doubles as its accessible description. */
    backLabel: string
    onBack: () => void
  }

  let { pluginId, backLabel, onBack }: Props = $props()

  /** Components a plugin can bundle, and what each one gives an agent. */
  const COMPONENT_NOTES: Record<AgentPluginMarketEntry['components'][number], string> = {
    skills: 'Instructions that teach agents when and how to use the plugin.',
    mcp: 'Tools that let agents take actions in the connected service.',
    hooks: 'Lifecycle hooks. Not runnable in CodeInOven yet.',
    agents: 'Subagent definitions. Not runnable in CodeInOven yet.',
    commands: 'Slash commands. Not runnable in CodeInOven yet.',
    apps: 'Desktop app integrations. Not runnable in CodeInOven yet.',
    lspServers: 'Language servers. Not runnable in CodeInOven yet.'
  }

  let detail = $state<AgentPluginDetail | null>(null)
  let installed = $state<InstalledAgentPlugin | null>(null)
  let icon = $state<string | null>(null)
  let loading = $state(true)
  let busy = $state(false)
  let confirmingUninstall = $state(false)
  let error = $state('')
  let success = $state('')

  /** Components CodeInOven cannot execute yet; the plugin still installs its other parts. */
  const UNSUPPORTED_COMPONENTS: ReadonlyArray<AgentPluginMarketEntry['components'][number]> = [
    'hooks',
    'agents',
    'commands',
    'apps',
    'lspServers'
  ]

  const entry = $derived(detail?.entry ?? null)
  const unsupportedComponents = $derived(
    entry?.components.filter((component) => UNSUPPORTED_COMPONENTS.includes(component)) ?? []
  )

  async function load(): Promise<void> {
    loading = true
    error = ''
    try {
      // The listing already warmed these while the card was hovered, so a
      // prefetched plugin opens with its facts and logo on screen.
      const [nextDetail, installedPlugins] = await Promise.all([
        loadAgentPluginDetail(pluginId),
        refreshInstalledAgentPlugins()
      ])
      detail = nextDetail
      installed = installedPlugins.find((plugin) => plugin.id === pluginId) ?? null
      if (nextDetail.entry.iconUrl) icon = await loadAgentPluginIcon(pluginId)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not load this plugin.'
    } finally {
      loading = false
    }
  }

  async function toggleBookmark(): Promise<void> {
    if (!entry) return
    await invoke('plugins:setBookmarked', entry.id, !entry.bookmarked)
    await invalidateAgentPluginMarket(entry.id)
    await load()
  }

  async function install(update: boolean): Promise<void> {
    if (!entry) return
    busy = true
    error = ''
    success = ''
    try {
      const result = update
        ? await invoke('plugins:update', entry.id)
        : await invoke('plugins:install', entry.id)
      success = `${result.displayName} ${update ? 'updated' : 'installed'}. Its skills and tools are in the tool gateway for every harness.`
      await invalidateAgentPluginMarket(entry.id)
      await load()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not install this plugin.'
    } finally {
      busy = false
    }
  }

  async function uninstall(): Promise<void> {
    if (!entry) return
    busy = true
    error = ''
    try {
      await invoke('plugins:uninstall', entry.id)
      confirmingUninstall = false
      success = `${entry.displayName} was uninstalled.`
      await invalidateAgentPluginMarket(entry.id)
      await load()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not uninstall this plugin.'
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void load()
  })
</script>

<div class="flex h-full min-h-0 flex-col">
  <header class="shrink-0 border-b bg-app px-6 pt-5 pb-4">
    <button
      class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
      type="button"
      title={backLabel}
      aria-label={backLabel}
      onclick={onBack}
    >
      <ArrowLeft size={13} />
      {backLabel}
    </button>

    {#if entry}
      <div class="mt-4 flex min-w-0 items-start gap-4">
        <div
          class="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border bg-elevated text-xl font-semibold text-muted"
        >
          {#if icon}<img src={icon} alt="" class="size-full object-cover" />{:else}{pluginInitials(
              entry.displayName
            )}{/if}
        </div>
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-xl font-bold tracking-tight">{entry.displayName}</h1>
          <p class="mt-0.5 text-sm text-muted">
            {entry.publisher ?? entry.source.repository}
            · {entry.platform === 'claude' ? 'Claude Code' : 'Codex'}
            {#if entry.version}· v{entry.version}{/if}
          </p>
          <p class="mt-2 text-sm leading-relaxed text-muted">{entry.description}</p>
        </div>
      </div>

      <div class="mt-4 flex flex-wrap items-center gap-2">
        {#if entry.installed && installed}
          <button
            type="button"
            class="flex h-9 items-center gap-1.5 rounded-lg border bg-elevated px-3 text-sm hover:bg-overlay disabled:opacity-50"
            onclick={() => void install(true)}
            disabled={busy}
            title={`Update ${entry.displayName}`}
            aria-label={`Update ${entry.displayName}`}
          >
            {#if busy}<Loader2 size={14} class="animate-spin" />{:else}<RefreshCw size={14} />{/if}
            {entry.updateAvailable ? 'Update' : 'Check for update'}
          </button>
          <button
            type="button"
            class="flex h-9 items-center gap-1.5 rounded-lg border px-3 text-sm text-red-500 hover:bg-red-500/5 disabled:opacity-50"
            onclick={() => (confirmingUninstall = true)}
            disabled={busy}
            title={`Uninstall ${entry.displayName}`}
            aria-label={`Uninstall ${entry.displayName}`}
          >
            <Trash2 size={14} /> Uninstall
          </button>
        {:else}
          <button
            type="button"
            class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-on-primary disabled:opacity-50"
            onclick={() => void install(false)}
            disabled={busy || !entry.supported}
            title={`Install ${entry.displayName}`}
            aria-label={`Install ${entry.displayName}`}
          >
            {#if busy}<Loader2 size={14} class="animate-spin" />{:else}<Download size={14} />{/if}
            Install
          </button>
        {/if}
        <button
          type="button"
          class="flex size-9 items-center justify-center rounded-lg border bg-elevated hover:bg-overlay"
          onclick={() => void toggleBookmark()}
          title={entry.bookmarked
            ? `Remove bookmark for ${entry.displayName}`
            : `Bookmark ${entry.displayName}`}
          aria-label={entry.bookmarked
            ? `Remove bookmark for ${entry.displayName}`
            : `Bookmark ${entry.displayName}`}
          aria-pressed={entry.bookmarked}
        >
          <Bookmark size={15} fill={entry.bookmarked ? 'currentColor' : 'none'} />
        </button>
      </div>
    {/if}
  </header>

  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto px-6 pt-5 pb-24 lg:flex-row lg:gap-8">
    <div class="min-w-0 lg:flex-1">
      {#if error}
        <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </p>
      {/if}
      {#if success}
        <p class="mb-4 rounded-lg bg-success/10 px-3 py-2 text-xs text-success" role="status">
          {success}
        </p>
      {/if}

      <section aria-labelledby="plugin-readme-title">
        <h2 id="plugin-readme-title" class="mb-3 flex items-center gap-2 text-sm font-semibold">
          <BookOpen size={14} class="text-muted" /> README
        </h2>
        {#if loading}
          <div class="space-y-3" aria-label="Loading plugin README">
            <div class="h-4 w-3/5 animate-pulse rounded bg-raised"></div>
            <div class="h-4 w-full animate-pulse rounded bg-raised"></div>
            <div class="h-4 w-4/5 animate-pulse rounded bg-raised"></div>
          </div>
        {:else if detail?.readme}
          <MarkdownView text={detail.readme} />
        {:else}
          <p class="text-sm text-muted">This plugin's repository has no README.</p>
        {/if}
      </section>
    </div>

    <aside class="mt-8 flex flex-col gap-5 lg:mt-0 lg:w-80 lg:shrink-0 lg:overflow-y-auto">
      {#if entry}
        <section aria-labelledby="plugin-contents-title" class="rounded-xl border bg-surface p-4">
          <h2 id="plugin-contents-title" class="mb-3 text-sm font-semibold">What it adds</h2>
          <p class="mb-3 text-xs text-muted">
            Everything below installs into the tool gateway, so every harness you use can reach it.
          </p>
          <ul class="space-y-3">
            {#if detail && detail.skills.length > 0}
              <li class="flex gap-2.5 text-sm">
                <Sparkles size={15} class="mt-0.5 shrink-0 text-muted" />
                <div class="min-w-0">
                  <p class="font-medium">{detail.skills.length} skills</p>
                  <p class="break-words text-xs text-muted">{detail.skills.join(', ')}</p>
                </div>
              </li>
            {/if}
            {#if detail && detail.mcpServers.length > 0}
              <li class="flex gap-2.5 text-sm">
                <Server size={15} class="mt-0.5 shrink-0 text-muted" />
                <div class="min-w-0">
                  <p class="font-medium">{detail.mcpServers.length} tool servers</p>
                  <p class="break-words text-xs text-muted">{detail.mcpServers.join(', ')}</p>
                </div>
              </li>
            {/if}
            {#if !loading && detail && detail.skills.length === 0 && detail.mcpServers.length === 0}
              <li class="text-sm text-muted">This package declares no skills or tool servers.</li>
            {/if}
          </ul>
          <ul class="mt-4 space-y-2 border-t pt-3">
            {#each entry.components as component (component)}
              <li class="text-xs text-muted">
                <span class="font-medium text-foreground">{component}</span>
                · {COMPONENT_NOTES[component]}
              </li>
            {/each}
          </ul>
        </section>

        {#if unsupportedComponents.length > 0 || entry.unsupportedReason}
          <section class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <p class="flex items-center gap-2 font-medium text-amber-600">
              <TriangleAlert size={14} /> Not fully supported
            </p>
            <p class="mt-2 text-xs text-muted">
              {entry.unsupportedReason ??
                `This plugin uses ${unsupportedComponents.join(', ')}, which CodeInOven cannot run yet. Its skills and tools still install.`}
            </p>
          </section>
        {/if}

        {#if installed && installed.requiredCredentialVariables.length > 0}
          <section class="rounded-xl border bg-surface p-4 text-sm">
            <p class="font-medium">Setup needed</p>
            <p class="mt-1 text-xs text-muted">
              Configure {installed.requiredCredentialVariables.join(', ')} in this plugin's tool utilities
              before agents can connect.
            </p>
          </section>
        {/if}

        <section
          aria-labelledby="plugin-source-title"
          class="rounded-xl border bg-surface p-4 text-sm"
        >
          <h2 id="plugin-source-title" class="mb-3 text-sm font-semibold">Source</h2>
          <dl class="space-y-2 text-xs">
            <div>
              <dt class="text-muted">Repository</dt>
              <dd class="break-all">{entry.source.repository}</dd>
            </div>
            <div>
              <dt class="text-muted">Marketplace</dt>
              <dd>{entry.platform === 'claude' ? 'Claude Code' : 'Codex'} catalog</dd>
            </div>
            {#if entry.version}
              <div>
                <dt class="text-muted">Version</dt>
                <dd>{entry.version}</dd>
              </div>
            {/if}
          </dl>
          <div class="mt-4 flex flex-wrap gap-2">
            <button
              class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs hover:bg-overlay"
              type="button"
              title={`Open ${entry.source.repository} on GitHub`}
              aria-label={`Open ${entry.source.repository} on GitHub`}
              data-external-url={`https://github.com/${entry.source.repository}`}
              onclick={() => void openInBrowser(`https://github.com/${entry.source.repository}`)}
            >
              Repository <ExternalLink size={12} />
            </button>
            {#if entry.homepage}
              <button
                class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs hover:bg-overlay"
                type="button"
                title="Open the plugin homepage"
                aria-label="Open the plugin homepage"
                data-external-url={entry.homepage}
                onclick={() => void openInBrowser(entry.homepage ?? '')}
              >
                Homepage <ExternalLink size={12} />
              </button>
            {/if}
          </div>
        </section>
      {/if}
    </aside>
  </div>
</div>

<ConfirmDialog
  open={confirmingUninstall}
  title={`Uninstall ${entry?.displayName ?? 'plugin'}?`}
  confirmLabel="Uninstall"
  busy={busy && confirmingUninstall}
  onConfirm={() => void uninstall()}
  onCancel={() => (confirmingUninstall = false)}
>
  <p>Agents will no longer be able to use this plugin's skills or tools.</p>
</ConfirmDialog>
