<script lang="ts">
  import {
    ArrowDown,
    ArrowLeft,
    Bot,
    Braces,
    ChevronDown,
    ChevronUp,
    CircleCheck,
    CircleX,
    Clock3,
    Cloud,
    Copy,
    ExternalLink,
    Loader2,
    RefreshCw,
    Search,
    X
  } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import { copyText as copyTextToClipboard } from '$lib/copy-text'
  import { toast } from 'svelte-sonner'
  import { cloudDeployState, CloudDeployState } from '$lib/stores/cloud-deploy.svelte'
  import StatusPill, { type StatusTone } from '../ui/StatusPill.svelte'
  import type { CloudDeploymentContainer, CloudDeploymentDeployment } from '$shared/types'
  import {
    parseDeploymentLog,
    deploymentLogToText,
    type DeploymentLogLine
  } from '$lib/cloud/deployment-log'

  interface Props {
    projectId: string
    container: CloudDeploymentContainer
    onBack: () => void
    /** Push an updated status snapshot back into the panel/store cache. */
    onUpdated: (container: CloudDeploymentContainer) => void
    /** Hand the failing deployment to an agent, given its readable log text. */
    onRemediate: (logText: string) => void
  }

  let { projectId, container, onBack, onUpdated, onRemediate }: Props = $props()

  let error = $state('')
  let deployments = $state<CloudDeploymentDeployment[]>([])
  let deploymentsLoading = $state(false)
  let selectedDeploymentId = $state<string | null>(null)
  let logLoading = $state(false)
  let logError = $state('')

  // Search state for the in-log search (button + cmd/ctrl+f).
  let searchOpen = $state(false)
  let searchQuery = $state('')
  let activeMatch = $state(0)
  let searchInputEl = $state<HTMLInputElement | null>(null)
  let logScrollerEl = $state<HTMLElement | null>(null)

  // Refreshing + tailing state for the log detail.
  let refreshing = $state(false)
  let tail = $state(false)
  /** Used to auto-tail only when the log content actually grows. */
  let lastLogLength = $state(0)

  const logKey = $derived(
    selectedDeploymentId
      ? `${CloudDeployState.containerKey(projectId, container.providerKind, container.id)}/${selectedDeploymentId}`
      : CloudDeployState.containerKey(projectId, container.providerKind, container.id)
  )
  const log = $derived(cloudDeployState.containerLogs[logKey]?.value.log ?? '')

  const selectedDeployment = $derived(
    deployments.find((deployment) => deployment.id === selectedDeploymentId) ?? null
  )

  /** Human-readable lines for the current deployment log. */
  const logLines = $derived<DeploymentLogLine[]>(parseDeploymentLog(log))

  /** Readable log text (timestamp + output), used by copy and diagnose. */
  const readableLog = $derived(deploymentLogToText(logLines))

  /** Indexes of lines that match the current search query (case-insensitive). */
  const searchMatches = $derived.by((): number[] => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return []
    const indexes: number[] = []
    for (let i = 0; i < logLines.length; i += 1) {
      if (logLines[i].text.toLowerCase().includes(q)) indexes.push(i)
    }
    return indexes
  })

  function openSearch(): void {
    searchOpen = true
    activeMatch = searchMatches.length > 0 ? 0 : 0
    requestAnimationFrame(() => searchInputEl?.focus())
  }

  function closeSearch(): void {
    searchOpen = false
    searchQuery = ''
    activeMatch = 0
  }

  function goToMatch(delta: 1 | -1): void {
    if (searchMatches.length === 0) return
    activeMatch = (activeMatch + delta + searchMatches.length) % searchMatches.length
    scrollToMatch(activeMatch)
  }

  function scrollToMatch(index: number): void {
    const target = searchMatches[index]
    if (target === undefined) return
    requestAnimationFrame(() => {
      const el = logScrollerEl?.querySelector(`[data-log-line="${target}"]`)
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }

  function handleKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openSearch()
      return
    }
    if (event.key === 'Escape' && searchOpen) {
      event.preventDefault()
      closeSearch()
    }
  }

  $effect(() => {
    window.addEventListener('keydown', handleKeydown)
    return () => window.removeEventListener('keydown', handleKeydown)
  })

  const cachedStatus = $derived(
    cloudDeployState.containerStatuses[
      CloudDeployState.containerKey(projectId, container.providerKind, container.id)
    ]
  )
  const status = $derived(cachedStatus?.value ?? container)

  function message(reason: unknown): string {
    if (!(reason instanceof Error)) return 'The deployment log could not be loaded.'
    return reason.message
      .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      .replace(/^Error:\s*/u, '')
  }

  async function loadDeployments(force = false): Promise<void> {
    error = ''
    deploymentsLoading = true
    try {
      const list = await cloudDeployState.ensureDeployments(
        projectId,
        container.providerKind,
        container.id,
        force
      )
      deployments = list ?? []
      if (deployments.length === 0) {
        error = 'No deployments found for this container.'
        return
      }
      const fresh = await cloudDeployState.ensureContainerStatus(
        projectId,
        container.providerKind,
        container.id,
        force
      )
      if (fresh) onUpdated(fresh)
    } catch (reason) {
      error = message(reason)
    } finally {
      deploymentsLoading = false
    }
  }

  /**
   * Force a full refresh of everything shown on the current screen:
   * the deployment list, the container status, and — when a single deployment
   * is open — that deployment's log. The refresh button spins while this runs.
   */
  async function refresh(): Promise<void> {
    if (refreshing) return
    refreshing = true
    error = ''
    logError = ''
    try {
      const list = await cloudDeployState.ensureDeployments(
        projectId,
        container.providerKind,
        container.id,
        true
      )
      if (list) deployments = list
      const fresh = await cloudDeployState.ensureContainerStatus(
        projectId,
        container.providerKind,
        container.id,
        true
      )
      if (fresh) onUpdated(fresh)
      if (selectedDeploymentId) {
        await cloudDeployState.ensureContainerLog(
          projectId,
          container.providerKind,
          container.id,
          selectedDeploymentId,
          true
        )
      }
    } catch (reason) {
      error = message(reason)
    } finally {
      refreshing = false
    }
  }

  async function selectDeployment(deployment: CloudDeploymentDeployment): Promise<void> {
    selectedDeploymentId = deployment.id
    tail = false
    lastLogLength = 0
    logError = ''
    logLoading = true
    try {
      await cloudDeployState.ensureContainerLog(
        projectId,
        container.providerKind,
        container.id,
        deployment.id
      )
    } catch (reason) {
      logError = message(reason)
    } finally {
      logLoading = false
    }
  }

  /**
   * Auto-refresh the open deployment's log every 5 seconds while its status is
   * `building`. The interval is torn down whenever the deployment stops being
   * `building` (success/failed), the user navigates back to the list, or this
   * component unmounts (sidebar closed, thread switched, app closed). The store
   * dedupes concurrent requests, and the `refreshing` guard prevents clashing
   * refreshes when a poll overlaps a manual refresh.
   */
  $effect(() => {
    const status = selectedDeployment?.status
    if (status !== 'building') {
      tail = false
      return
    }
    const timer = setInterval(() => void refresh(), 5_000)
    return () => clearInterval(timer)
  })

  /** When tailing, keep the view pinned to the newest lines as the log grows. */
  $effect(() => {
    if (!tail) return
    const length = logLines.length
    if (length <= lastLogLength) return
    lastLogLength = length
    requestAnimationFrame(() => {
      logScrollerEl?.scrollTo({ top: logScrollerEl.scrollHeight })
    })
  })

  function toggleTail(): void {
    tail = !tail
    if (tail) {
      requestAnimationFrame(() => {
        logScrollerEl?.scrollTo({ top: logScrollerEl.scrollHeight })
      })
    }
  }

  async function copyLog(): Promise<void> {
    if (!readableLog) return
    try {
      await copyTextToClipboard(readableLog)
      toast.success('Deployment log copied.')
    } catch {
      toast.error('The log could not be copied.')
    }
  }

  /** Copy the raw log payload (the underlying JSON/raw text) unchanged. */
  async function copyRawLog(): Promise<void> {
    if (!log) return
    try {
      await copyTextToClipboard(log)
      toast.success('Raw log copied.')
    } catch {
      toast.error('The raw log could not be copied.')
    }
  }

  $effect(() => {
    void loadDeployments()
  })

  function tone(statusValue: CloudDeploymentContainer['status']): StatusTone {
    if (statusValue === 'success') return 'success'
    if (statusValue === 'failed') return 'danger'
    if (statusValue === 'building') return 'warning'
    return 'neutral'
  }

  function label(statusValue: CloudDeploymentContainer['status']): string {
    return statusValue === 'unknown' ? 'unknown' : statusValue
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <!-- Header -->
  <div class="shrink-0 border-b border-border px-3 py-2">
    <div class="flex items-center gap-1">
      {#if selectedDeployment}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Back to deployments"
          aria-label="Back to deployments"
          onclick={() => {
            selectedDeploymentId = null
            tail = false
          }}
        >
          <ArrowLeft size={13} />
        </button>
      {:else}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Back to cloud deployments"
          aria-label="Back to cloud deployments"
          onclick={onBack}
        >
          <ArrowLeft size={13} />
        </button>
      {/if}
      {#if status.status === 'building'}
        <Clock3 size={12} class="shrink-0 text-warning" />
      {:else if status.status === 'success'}
        <CircleCheck size={12} class="shrink-0 text-success" />
      {:else if status.status === 'failed'}
        <CircleX size={12} class="shrink-0 text-danger" />
      {:else}
        <Cloud size={12} class="shrink-0 text-muted" />
      {/if}
      <span class="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
        {container.label}
      </span>
      <StatusPill tone={tone(status.status)}>{label(status.status)}</StatusPill>
      {#if selectedDeployment?.status === 'failed'}
        <button
          type="button"
          class="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Diagnose this failed deployment with an agent"
          aria-label="Diagnose this failed deployment with an agent"
          onclick={() => onRemediate(readableLog)}
        >
          <Bot size={12} />
          Diagnose
        </button>
      {/if}
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Refresh deployment log"
        aria-label="Refresh deployment log"
        onclick={() => void refresh()}
      >
        <RefreshCw size={12} class={refreshing ? 'animate-spin' : ''} />
      </button>
      {#if selectedDeployment}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Jump to the latest log lines"
          aria-label="Jump to the latest log lines"
          onclick={toggleTail}
        >
          <ArrowDown size={12} class={tail ? 'text-foreground' : ''} />
        </button>
      {/if}
      {#if container.url}
        <button
          type="button"
          class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          title="Open deployed site"
          aria-label="Open deployed site"
          onclick={() => void openInBrowser(container.url ?? '')}
        >
          <ExternalLink size={12} />
        </button>
      {/if}
    </div>
    <div class="mt-1 flex items-center gap-1.5 text-[9px] text-dimmed">
      {#if selectedDeployment}
        <span class="font-mono">{selectedDeployment.id.slice(0, 12)}</span>
        {#if selectedDeployment.commit}
          <span>·</span>
          <span class="font-mono">{selectedDeployment.commit.slice(0, 7)}</span>
        {/if}
        {#if selectedDeployment.updatedAt}
          <span>·</span>
          <span>{relativeTime(selectedDeployment.updatedAt)}</span>
        {/if}
      {:else}
        <span class="font-mono">{container.id}</span>
        <span>·</span>
        <span>{container.providerKind}</span>
      {/if}
    </div>
  </div>

  <!-- Body -->
  <div class="min-h-0 flex-1 overflow-y-auto" bind:this={logScrollerEl}>
    {#if selectedDeployment}
      <!-- Single deployment detail + its log -->
      <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
        <span class="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Deployment log
        </span>
        {#if selectedDeployment.status && selectedDeployment.status !== 'unknown'}
          <span class="ml-1">
            <StatusPill tone={tone(selectedDeployment.status)}>
              {label(selectedDeployment.status)}
            </StatusPill>
          </span>
        {/if}
        {#if log}
          <button
            type="button"
            class="ml-auto flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Search log (Ctrl/Cmd+F)"
            aria-label="Search log"
            onclick={openSearch}
          >
            <Search size={10} />
            Search
          </button>
          <button
            type="button"
            class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Copy build log"
            aria-label="Copy build log"
            onclick={() => void copyLog()}
          >
            <Copy size={10} />
            Copy
          </button>
          <button
            type="button"
            class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Copy raw log JSON"
            aria-label="Copy raw log JSON"
            onclick={() => void copyRawLog()}
          >
            <Braces size={10} />
            Copy raw
          </button>
        {/if}
      </div>
      {#if searchOpen}
        <div class="flex items-center gap-1.5 border-b border-border bg-surface px-3 py-1.5">
          <Search size={11} class="shrink-0 text-dimmed" />
          <input
            bind:this={searchInputEl}
            bind:value={searchQuery}
            type="text"
            class="h-6 min-w-0 flex-1 rounded border border-border bg-elevated px-2 text-[10px] text-foreground outline-none placeholder:text-dimmed"
            placeholder="Search in log…"
            aria-label="Search in deployment log"
            oninput={() => {
              activeMatch = 0
              scrollToMatch(0)
            }}
          />
          <span class="shrink-0 text-[9px] tabular-nums text-dimmed">
            {searchMatches.length > 0 ? `${activeMatch + 1}/${searchMatches.length}` : '0/0'}
          </span>
          <button
            type="button"
            class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Previous match"
            aria-label="Previous match"
            onclick={() => goToMatch(-1)}
          >
            <ChevronUp size={12} />
          </button>
          <button
            type="button"
            class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Next match"
            aria-label="Next match"
            onclick={() => goToMatch(1)}
          >
            <ChevronDown size={12} />
          </button>
          <button
            type="button"
            class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            title="Close search"
            aria-label="Close search"
            onclick={closeSearch}
          >
            <X size={12} />
          </button>
        </div>
      {/if}
      {#if logLoading}
        <div class="flex items-center justify-center gap-2 px-6 py-8 text-[11px] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading log
        </div>
      {:else if logLines.length > 0}
        <div class="p-3">
          <div class="space-y-0.5 font-mono text-[10px] leading-relaxed">
            {#each logLines as line, index (index)}
              {@const matchIndex = searchMatches.indexOf(index)}
              {@const isActiveMatch = matchIndex !== -1 && matchIndex === activeMatch}
              <div
                data-log-line={index}
                class="rounded px-2 py-0.5 whitespace-pre-wrap break-words {line.isError
                  ? 'bg-danger/10 text-danger'
                  : 'text-muted'}{matchIndex !== -1
                  ? ' bg-accent/20 ring-1 ring-inset ring-accent/40'
                  : ''}{isActiveMatch ? ' ring-2 ring-accent' : ''}"
              >
                {line.text}
              </div>
            {/each}
          </div>
        </div>
      {:else if logError}
        <div class="flex flex-col items-center gap-3 px-6 py-8 text-center">
          <CircleX size={18} class="text-danger" />
          <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">{logError}</p>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[11px] font-medium text-foreground hover:bg-elevated"
            onclick={() => void selectDeployment(selectedDeployment)}
          >
            Try again
          </button>
        </div>
      {:else}
        <div class="flex items-center justify-center gap-2 px-6 py-8 text-[11px] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading log
        </div>
      {/if}
    {:else}
      <!-- Deployment history list -->
      <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
        <span class="text-[10px] font-semibold uppercase tracking-wide text-muted">
          Deployment history
        </span>
        {#if deployments.length > 0}
          <span class="ml-auto text-[9px] tabular-nums text-dimmed">{deployments.length}</span>
        {/if}
      </div>
      {#if deploymentsLoading && deployments.length === 0}
        <div class="flex items-center justify-center gap-2 px-3 py-8 text-[11px] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading deployments
        </div>
      {:else if deployments.length === 0}
        <div class="flex flex-col items-center gap-3 px-6 py-8 text-center">
          {#if error}
            <CircleX size={18} class="text-danger" />
          {/if}
          <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">
            {error || 'No deployments found for this container.'}
          </p>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[11px] font-medium text-foreground hover:bg-elevated"
            onclick={() => void loadDeployments(true)}
          >
            Try again
          </button>
        </div>
      {:else}
        <div class="divide-y divide-border">
          {#each deployments as deployment (deployment.id)}
            <button
              type="button"
              class="flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-elevated"
              title="View this deployment's log"
              aria-label="View deployment {deployment.id}"
              onclick={() => void selectDeployment(deployment)}
            >
              {#if deployment.status === 'building'}
                <Clock3 size={14} class="shrink-0 text-warning" />
              {:else if deployment.status === 'success'}
                <CircleCheck size={14} class="shrink-0 text-success" />
              {:else if deployment.status === 'failed'}
                <CircleX size={14} class="shrink-0 text-danger" />
              {:else}
                <Cloud size={14} class="shrink-0 text-muted" />
              {/if}
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium text-foreground">
                  {deployment.id}
                </span>
                <span class="mt-0.5 block text-[10px] text-dimmed">
                  {#if deployment.commit}
                    <span class="font-mono">{deployment.commit.slice(0, 7)}</span>
                    <span> · </span>
                  {/if}
                  {deployment.updatedAt ? relativeTime(deployment.updatedAt) : '—'}
                </span>
              </span>
              {#if deployment.status !== 'unknown'}
                <StatusPill tone={tone(deployment.status)}>{label(deployment.status)}</StatusPill>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>
