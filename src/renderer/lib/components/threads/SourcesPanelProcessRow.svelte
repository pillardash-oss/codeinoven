<script lang="ts">
  import { Globe2, Loader2, SquareTerminal } from '@lucide/svelte'
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
      class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised {isAppWide
        ? 'text-muted'
        : 'text-primary'}"
    >
      {#if isAppWide}
        <Globe2 size={15} />
      {:else}
        <SquareTerminal size={15} />
      {/if}
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex items-center gap-2">
        <p class="truncate text-xs font-semibold text-foreground">
          {name}
        </p>
        {#if isAppWide}
          <span
            class="shrink-0 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-500"
          >
            App
          </span>
        {/if}
        <span class="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted">
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
      class="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2 text-[0.6875rem] font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
      disabled={stopping}
      aria-label={`Stop ${name} process ${runningProcess.pid}`}
      title={stopTitle}
      onclick={() => onStop(runningProcess.pid)}
    >
      {#if stopping}
        <Loader2 size={12} class="animate-spin" />
      {/if}
      Stop
    </button>
  </div>
</div>
