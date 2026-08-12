<script lang="ts">
  import {
    ArrowLeft,
    Bot,
    CircleCheck,
    CircleX,
    Clock3,
    Cloud,
    Copy,
    ExternalLink,
    Loader2,
    RefreshCw,
    Terminal
  } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import { copyText as copyTextToClipboard } from '$lib/copy-text'
  import { toast } from 'svelte-sonner'
  import { cloudDeployState, CloudDeployState } from '$lib/stores/cloud-deploy.svelte'
  import StatusPill, { type StatusTone } from '../ui/StatusPill.svelte'
  import type { CloudDeploymentContainer, CloudDeploymentDeployment } from '$shared/types'

  interface Props {
    projectId: string
    container: CloudDeploymentContainer
    onBack: () => void
    /** Push an updated status snapshot back into the panel/store cache. */
    onUpdated: (container: CloudDeploymentContainer) => void
    /** Hand the failing deployment to an agent for read-only diagnosis. */
    onRemediate: () => void
  }

  let { projectId, container, onBack, onUpdated, onRemediate }: Props = $props()

  let error = $state('')
  let deployments = $state<CloudDeploymentDeployment[]>([])
  let deploymentsLoading = $state(false)
  let selectedDeploymentId = $state<string | null>(null)

  /** Detail is served from the store cache so re-entering the view is instant. */
  const logKey = $derived(
    selectedDeploymentId
      ? `${CloudDeployState.containerKey(projectId, container.providerKind, container.id)}/${selectedDeploymentId}`
      : CloudDeployState.containerKey(projectId, container.providerKind, container.id)
  )
  const log = $derived(cloudDeployState.containerLogs[logKey]?.value.log ?? '')

  const selectedDeployment = $derived(
    deployments.find((deployment) => deployment.id === selectedDeploymentId) ?? null
  )

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
      // Auto-select the most recent deployment.
      if (!selectedDeploymentId) selectedDeploymentId = deployments[0].id
      await loadLog(selectedDeploymentId, force)
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

  async function loadLog(deploymentId: string | null, force = false): Promise<void> {
    try {
      await cloudDeployState.ensureContainerLog(
        projectId,
        container.providerKind,
        container.id,
        deploymentId ?? undefined,
        force
      )
    } catch (reason) {
      error = message(reason)
    }
  }

  async function selectDeployment(deployment: CloudDeploymentDeployment): Promise<void> {
    selectedDeploymentId = deployment.id
    error = ''
    await loadLog(deployment.id)
  }

  async function copyLog(): Promise<void> {
    if (!log) return
    try {
      await copyTextToClipboard(log)
      toast.success('Deployment log copied.')
    } catch {
      toast.error('The log could not be copied.')
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
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to deployments"
        aria-label="Back to deployments"
        onclick={onBack}
      >
        <ArrowLeft size={13} />
      </button>
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
      {#if status.status === 'failed'}
        <button
          type="button"
          class="flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 text-[10px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Diagnose this failed deployment with an agent"
          aria-label="Diagnose this failed deployment with an agent"
          onclick={onRemediate}
        >
          <Bot size={12} />
          Diagnose
        </button>
      {/if}
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Refresh deployments"
        aria-label="Refresh deployments"
        onclick={() => void loadDeployments(true)}
      >
        <RefreshCw size={12} />
      </button>
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
      <span class="font-mono">{container.id}</span>
      <span>·</span>
      <span>{container.providerKind}</span>
    </div>
  </div>

  <!-- Body -->
  <div class="grid min-h-0 flex-1 grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
    <!-- Deployment list -->
    <div class="min-h-0 overflow-y-auto border-r border-border">
      <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
        <Terminal size={11} class="text-dimmed" />
        <h3 class="text-[10px] font-semibold uppercase tracking-wide text-muted">Deployments</h3>
      </div>
      {#if deploymentsLoading && deployments.length === 0}
        <div class="flex items-center justify-center gap-2 px-3 py-6 text-[11px] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading
        </div>
      {:else if deployments.length === 0}
        <div class="flex flex-col items-center gap-3 px-3 py-6 text-center">
          {#if error}
            <p class="text-[10px] leading-relaxed text-dimmed">{error}</p>
          {:else}
            <p class="text-[10px] leading-relaxed text-dimmed">No deployments yet.</p>
          {/if}
          <button
            type="button"
            class="h-7 cursor-pointer rounded-lg border border-border px-2.5 text-[10px] font-medium text-foreground hover:bg-elevated"
            onclick={() => void loadDeployments(true)}
          >
            Try again
          </button>
        </div>
      {:else}
        <div class="divide-y divide-border">
          {#each deployments as deployment (deployment.id)}
            {@const active = deployment.id === selectedDeploymentId}
            <button
              type="button"
              class="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors {active
                ? 'bg-selected'
                : 'hover:bg-elevated'}"
              aria-pressed={active}
              onclick={() => void selectDeployment(deployment)}
            >
              {#if deployment.status === 'building'}
                <Clock3 size={12} class="shrink-0 text-warning" />
              {:else if deployment.status === 'success'}
                <CircleCheck size={12} class="shrink-0 text-success" />
              {:else if deployment.status === 'failed'}
                <CircleX size={12} class="shrink-0 text-danger" />
              {:else}
                <Cloud size={12} class="shrink-0 text-muted" />
              {/if}
              <span class="min-w-0 flex-1">
                <span class="block truncate font-mono text-[10px] text-foreground">
                  {deployment.id.slice(0, 8)}
                </span>
                {#if deployment.commit}
                  <span class="block truncate font-mono text-[9px] text-dimmed">
                    {deployment.commit.slice(0, 7)}
                  </span>
                {/if}
              </span>
              {#if deployment.updatedAt}
                <span class="shrink-0 text-[9px] text-dimmed">
                  {relativeTime(deployment.updatedAt)}
                </span>
              {/if}
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Log -->
    <div class="min-h-0 overflow-y-auto">
      <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
        <Terminal size={11} class="text-dimmed" />
        <h3 class="text-[10px] font-semibold uppercase tracking-wide text-muted">Build log</h3>
        {#if selectedDeployment?.status}
          <span class="ml-auto">
            <StatusPill tone={tone(selectedDeployment.status)}>
              {label(selectedDeployment.status)}
            </StatusPill>
          </span>
        {/if}
        {#if log}
          <button
            type="button"
            class="ml-2 flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded border border-border px-1.5 text-[9px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
            title="Copy build log"
            aria-label="Copy build log"
            onclick={() => void copyLog()}
          >
            <Copy size={10} />
            Copy
          </button>
        {/if}
      </div>

      {#if log}
        <div class="p-3">
          <pre
            class="max-h-[calc(100vh-16rem)] overflow-auto rounded-md bg-elevated p-3 font-mono text-[10px] leading-relaxed text-muted">{log}</pre>
        </div>
      {:else if deploymentsLoading}
        <div class="flex items-center justify-center gap-2 px-6 py-8 text-[11px] text-dimmed">
          <Loader2 size={13} class="animate-spin" />
          Loading log
        </div>
      {:else if error}
        <div class="flex flex-col items-center gap-3 px-6 py-8 text-center">
          <CircleX size={18} class="text-danger" />
          <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">{error}</p>
          <button
            type="button"
            class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[11px] font-medium text-foreground hover:bg-elevated"
            onclick={() => void loadDeployments(true)}
          >
            Try again
          </button>
        </div>
      {:else}
        <div class="flex items-center justify-center gap-2 px-6 py-8 text-[11px] text-dimmed">
          Select a deployment to view its build log.
        </div>
      {/if}
    </div>
  </div>
</div>
