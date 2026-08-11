<script lang="ts">
  import {
    ArrowLeft,
    CircleCheck,
    CircleX,
    Clock3,
    Cloud,
    ExternalLink,
    Loader2,
    RefreshCw,
    Terminal
  } from '@lucide/svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { relativeTime } from '$lib/format/relative-time'
  import { cloudDeployState, CloudDeployState } from '$lib/stores/cloud-deploy.svelte'
  import StatusPill, { type StatusTone } from '../ui/StatusPill.svelte'
  import type { CloudDeploymentContainer } from '$shared/types'

  interface Props {
    projectId: string
    container: CloudDeploymentContainer
    onBack: () => void
    /** Push an updated status snapshot back into the panel/store cache. */
    onUpdated: (container: CloudDeploymentContainer) => void
  }

  let { projectId, container, onBack, onUpdated }: Props = $props()

  let error = $state('')

  /** Detail is served from the store cache so re-entering the view is instant. */
  const cached = $derived(
    cloudDeployState.containerLogs[
      CloudDeployState.containerKey(container.providerKind, container.id)
    ]
  )
  const log = $derived(cached?.value.log ?? '')

  const cachedStatus = $derived(
    cloudDeployState.containerStatuses[
      CloudDeployState.containerKey(container.providerKind, container.id)
    ]
  )
  const status = $derived(cachedStatus?.value ?? container)

  function message(reason: unknown): string {
    if (!(reason instanceof Error)) return 'The deployment log could not be loaded.'
    return reason.message
      .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
      .replace(/^Error:\s*/u, '')
  }

  async function load(force = false): Promise<void> {
    error = ''
    try {
      const result = await cloudDeployState.ensureContainerLog(
        projectId,
        container.providerKind,
        container.id,
        force
      )
      const fresh = await cloudDeployState.ensureContainerStatus(
        projectId,
        container.providerKind,
        container.id,
        force
      )
      if (fresh) onUpdated(fresh)
      if (!result?.log) error = 'No deployment log is available for this container.'
    } catch (reason) {
      error = message(reason)
    }
  }

  $effect(() => {
    void load()
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
      <button
        type="button"
        class="cursor-pointer rounded p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Refresh log"
        aria-label="Refresh log"
        onclick={() => void load(true)}
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
      {#if status.updatedAt}
        <span>·</span>
        <span>{relativeTime(status.updatedAt)}</span>
      {/if}
    </div>
  </div>

  <!-- Body -->
  <div class="min-h-0 flex-1 overflow-y-auto">
    <div class="flex items-center gap-2 bg-surface px-3 py-1.5">
      <Terminal size={11} class="text-dimmed" />
      <h3 class="text-[10px] font-semibold uppercase tracking-wide text-muted">Deployment log</h3>
    </div>

    {#if log}
      <div class="p-3">
        <pre
          class="max-h-64 overflow-auto rounded-md bg-elevated p-2 font-mono text-[9px] leading-relaxed text-muted">{log}</pre>
      </div>
    {:else if error}
      <div class="flex flex-col items-center gap-3 px-6 py-8 text-center">
        <CircleX size={18} class="text-danger" />
        <p class="max-w-[42ch] text-[10px] leading-relaxed text-dimmed">{error}</p>
        <button
          type="button"
          class="h-8 cursor-pointer rounded-lg border border-border px-3 text-[11px] font-medium text-foreground hover:bg-elevated"
          onclick={() => void load(true)}
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

    {#if log && status.status === 'failed'}
      <p class="px-3 pb-3 text-[9px] leading-relaxed text-dimmed">
        This deployment failed. Review the log above to diagnose the cause.
      </p>
    {/if}
  </div>
</div>
