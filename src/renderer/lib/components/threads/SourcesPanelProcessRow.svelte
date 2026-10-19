<script lang="ts">
  import CioBrowser from '@pdslng/cio-icon/CioBrowser.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTerminal from '@pdslng/cio-icon/CioTerminal.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import type { AgentRunningProcess } from '$shared/types'
  import { processName, processStartedAt } from './sources-panel-helpers'

  interface Props {
    process: AgentRunningProcess
    /** `app` rows run under a shared server and are labelled as such. */
    variant: 'thread' | 'app'
    /** True while this pid's stop request is in flight. */
    stopping: boolean
    onStop: (pid: number) => void
  }

  let { process: runningProcess, variant, stopping, onStop }: Props = $props()

  const name = $derived(processName(runningProcess.command))
  const isAppWide = $derived(variant === 'app')
  const stopTitle = $derived(
    isAppWide
      ? `Stop app-wide process ${runningProcess.pid}. This affects every thread using the app.`
      : `Stop process ${runningProcess.pid}`
  )
</script>

<div
  class="border-b border-border px-4 py-3 transition-colors hover:bg-elevated"
  title={isAppWide ? runningProcess.command : undefined}
>
  <div class="flex items-start gap-3">
    <span
      class="flex h-8 w-8 shrink-0 items-center justify-center bg-raised {isAppWide
        ? 'text-muted'
        : 'text-primary'}"
    >
      {#if isAppWide}
        <CioBrowser size={ICON_SIZE.row} />
      {:else}
        <CioTerminal size={15} />
      {/if}
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <p class="truncate text-xs font-semibold text-foreground">
          {name}
        </p>
        {#if isAppWide}
          <span
            class="shrink-0 border border-amber-500/30 bg-amber-500/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-amber-500 uppercase"
          >
            App
          </span>
        {/if}
        <span
          class="shrink-0 border border-border bg-raised px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase"
        >
          Running
        </span>
      </div>
      <p
        class="mt-1 line-clamp-2 font-mono text-[0.625rem] leading-relaxed text-dimmed"
        title={runningProcess.command}
      >
        {runningProcess.command}
      </p>
      <p class="mt-1 text-[0.625rem] text-dimmed tabular-nums">
        PID {runningProcess.pid} · Started {processStartedAt(runningProcess.startedAt)}
      </p>
    </div>
    <button
      type="button"
      class="flex h-7 shrink-0 items-center gap-1.5 border border-danger/30 bg-danger/10 px-2 text-[0.6875rem] font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
      disabled={stopping}
      aria-label={`Stop ${name} process ${runningProcess.pid}`}
      title={stopTitle}
      onclick={() => onStop(runningProcess.pid)}
    >
      {#if stopping}
        <CioSpinner size={12} class="animate-spin" />
      {/if}
      Stop
    </button>
  </div>
</div>
