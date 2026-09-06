<script lang="ts">
  import { CheckCircle2, Loader2, X, XCircle } from '@lucide/svelte'
  import { type Attachment } from 'svelte/attachments'
  import { SvelteMap } from 'svelte/reactivity'
  import DockableModal from '../ui/DockableModal.svelte'
  import ProviderLoginTerminal from './ProviderLoginTerminal.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import {
    harnessLifecycleStore,
    type HarnessRun,
    type HarnessRunKind
  } from '$lib/stores/harness-lifecycle.svelte'

  const store = harnessLifecycleStore

  /** TerminalId → run card element, filled by the {@attach registerRun} attachment. */
  const runElements = new SvelteMap<string, HTMLDivElement>()

  const registerRun: Attachment<HTMLDivElement> = (node) => {
    const terminalId = node.dataset['terminalId']
    if (!terminalId) return
    runElements.set(terminalId, node)
    return () => runElements.delete(terminalId)
  }

  $effect(() => {
    const target = store.focusedHarnessId
    if (target === null) return
    runElements.get(target)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  function verb(kind: HarnessRunKind): string {
    return kind === 'uninstall' ? 'uninstall' : 'update'
  }

  function activeLabel(kind: HarnessRunKind): string {
    return kind === 'uninstall' ? 'Uninstalling' : 'Updating'
  }

  function finishedLabel(kind: HarnessRunKind): string {
    return kind === 'uninstall' ? 'Uninstalled' : 'Updated'
  }

  function dockTitle(run: HarnessRun): string {
    if (run.exitCode === undefined) {
      return run.kind === 'uninstall'
        ? `${run.harnessName} is uninstalling`
        : `${run.harnessName} is updating`
    }
    if (run.exitCode === 0) {
      return run.kind === 'uninstall'
        ? `${run.harnessName} uninstalled`
        : `${run.harnessName} updated`
    }
    const action = verb(run.kind)
    return `${run.harnessName} ${action} exited with code ${run.exitCode}`
  }

  function panelTitle(): string {
    const kinds = new Set(store.runs.map((run) => run.kind))
    if (kinds.size === 1 && kinds.has('uninstall')) return 'Uninstall harnesses'
    if (kinds.size === 1 && kinds.has('update')) return 'Update harnesses'
    return 'Harness tasks'
  }

  /** Max pictograms shown in the dock before the rest collapse into a +N badge. */
  const MAX_DOCK_ICONS = 3

  const visibleRuns = $derived(store.runs.slice(0, MAX_DOCK_ICONS))
  const overflowCount = $derived(Math.max(0, store.runs.length - MAX_DOCK_ICONS))

  function overflowTitle(count: number): string {
    const noun = count === 1 ? 'task' : 'tasks'
    return `${count} more harness ${noun}`
  }

  function dockLabel(): string {
    const kinds = new Set(store.runs.map((run) => run.kind))
    if (kinds.size === 1 && kinds.has('uninstall')) return 'Uninstalls'
    if (kinds.size === 1 && kinds.has('update')) return 'Updates'
    return 'Tasks'
  }

  function footerNote(): string {
    return store.finishedCount === store.runs.length
      ? 'Tasks keep running while you work — click the dock in the bottom-right corner or press Escape to bring them back.'
      : 'Tasks keep running while you work — click the dock in the bottom-right corner or press Escape to bring them back, and close once all of them finish.'
  }
</script>

<DockableModal
  open
  title={panelTitle()}
  minimized={store.minimized}
  closable={store.hasFinished}
  onMinimize={() => store.minimize()}
  onClose={() => store.close()}
  onExpand={() => store.expandAll()}
>
  {#snippet dock()}
    <div class="flex items-center gap-1 rounded-xl border bg-surface p-1.5 shadow-xl">
      <button
        class="rounded-lg px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Show all harness tasks"
        title="Show all harness tasks"
        onclick={() => store.expandAll()}
      >
        {dockLabel()}
      </button>
      <span class="h-5 w-px bg-border"></span>
      {#each visibleRuns as run (run.terminalId)}
        <button
          class="relative flex h-8 w-8 items-center justify-center rounded-lg transition-colors hover:bg-elevated"
          title={dockTitle(run)}
          aria-label={dockTitle(run)}
          onclick={() => store.focusRun(run.harnessId)}
        >
          <AgentIcon agentId={run.harnessId} label={run.harnessName} size={16} />
          {#if run.exitCode === undefined}
            <span
              class="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-info"
              aria-hidden="true"
            ></span>
          {:else if run.exitCode === 0}
            <CheckCircle2
              size={10}
              class="absolute -right-1 -top-1 rounded-full bg-surface text-success"
              aria-hidden="true"
            />
          {:else}
            <XCircle
              size={10}
              class="absolute -right-1 -top-1 rounded-full bg-surface text-danger"
              aria-hidden="true"
            />
          {/if}
        </button>
      {/each}
      {#if overflowCount > 0}
        <span
          class="flex h-6 min-w-6 items-center justify-center rounded-full bg-elevated px-1.5 font-mono text-[0.625rem] font-semibold text-muted"
          title={overflowTitle(overflowCount)}
          aria-label={overflowTitle(overflowCount)}
        >
          +{overflowCount}
        </span>
      {/if}
      {#if store.hasFinished}
        <span class="h-5 w-px bg-border"></span>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close tasks"
          title="Close tasks"
          onclick={() => store.close()}
        >
          <X size={14} />
        </button>
      {/if}
    </div>
  {/snippet}

  {#if store.runs.length === 0}
    <p class="py-8 text-center text-xs text-dimmed">No tasks are running.</p>
  {:else}
    <div class="space-y-3">
      {#each store.runs as run (run.terminalId)}
        <div
          class="overflow-hidden rounded-xl border bg-surface transition-shadow {run.harnessId ===
          store.focusedHarnessId
            ? 'ring-1 ring-primary'
            : ''}"
          data-terminal-id={run.terminalId}
          {@attach registerRun}
        >
          <div class="flex items-center justify-between gap-3 border-b px-3 py-2">
            <div class="flex min-w-0 items-center gap-2">
              <AgentIcon agentId={run.harnessId} label={run.harnessName} size={14} />
              <span class="truncate text-xs font-medium">{run.harnessName}</span>
              <code class="truncate font-mono text-[0.625rem] text-dimmed">
                $ {run.handoff.command}
                {run.handoff.args.join(' ')}
              </code>
            </div>
            {#if run.exitCode === undefined}
              <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-info">
                <Loader2 size={11} class="animate-spin" />
                {activeLabel(run.kind)}
              </span>
            {:else if run.exitCode === 0}
              <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-success">
                <CheckCircle2 size={11} />
                {finishedLabel(run.kind)}
              </span>
            {:else}
              <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-danger">
                <XCircle size={11} /> Exited with code {run.exitCode}
              </span>
            {/if}
          </div>
          <div class="h-48 overflow-hidden">
            <ProviderLoginTerminal
              terminalId={run.terminalId}
              command={run.handoff.command}
              args={run.handoff.args}
              onExit={(exitCode) => void store.handleRunExit(run.harnessId, exitCode)}
            />
          </div>
        </div>
      {/each}
      <p class="text-[0.6875rem] text-dimmed">{footerNote()}</p>
    </div>
  {/if}
</DockableModal>
