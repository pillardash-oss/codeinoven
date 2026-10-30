<script lang="ts">
  import CioCheckCircle from '@pdslng/cio-icon/CioCheckCircle.svelte'
  import CioClose from '@pdslng/cio-icon/CioClose.svelte'
  import CioCrossCircle from '@pdslng/cio-icon/CioCrossCircle.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { APP_SLUG } from '$shared/brand'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import DockableModal from '../../ui/DockableModal.svelte'
  import DockRow from '../../ui/DockRow.svelte'
  import ProviderLoginTerminal from '../../providers/ProviderLoginTerminal.svelte'
  import type { BrewJob } from './local-ai-controller.svelte'

  interface Props {
    job: BrewJob
    minimized: boolean
    /** Null while the job is still running. */
    jobExitCode: number | null
    jobCancelled: boolean
    jobStopping: boolean
    onMinimize: () => void
    onExpand: () => void
    onClose: () => void
    onStop: () => void
    onExit: (exitCode: number) => void
  }

  let {
    job,
    minimized,
    jobExitCode,
    jobCancelled,
    jobStopping,
    onMinimize,
    onExpand,
    onClose,
    onStop,
    onExit
  }: Props = $props()

  /** Shared with the panel placement, so the dock belongs to this clock alone. */
  const PANEL_STORAGE_KEY = `${APP_SLUG}.localAiTasksPanel.v1`

  const finished = $derived(jobExitCode !== null)

  function verb(kind: BrewJob['kind']): string {
    return kind === 'uninstall' ? 'uninstall' : kind === 'install' ? 'install' : 'update'
  }

  function activeLabel(kind: BrewJob['kind']): string {
    if (kind === 'uninstall') return 'Uninstalling'
    return kind === 'install' ? 'Installing' : 'Updating'
  }

  function finishedLabel(kind: BrewJob['kind']): string {
    if (kind === 'uninstall') return 'Uninstalled'
    return kind === 'install' ? 'Installed' : 'Updated'
  }

  const title = $derived.by(() => {
    if (jobCancelled) return 'llama.cpp job stopped'
    if (jobExitCode === null) {
      return job.kind === 'uninstall'
        ? 'llama.cpp is uninstalling'
        : job.kind === 'install'
          ? 'llama.cpp is installing'
          : 'llama.cpp is updating'
    }
    if (jobExitCode === 0) {
      return job.kind === 'uninstall'
        ? 'llama.cpp uninstalled'
        : job.kind === 'install'
          ? 'llama.cpp installed'
          : 'llama.cpp updated'
    }
    return `llama.cpp ${verb(job.kind)} exited with code ${jobExitCode}`
  })
</script>

<DockableModal
  open
  {title}
  {minimized}
  closable={finished}
  {onMinimize}
  {onClose}
  storageKey={PANEL_STORAGE_KEY}
  dragLabel="Move docked Local AI task"
>
  {#snippet dock()}
    <DockRow storageKey={PANEL_STORAGE_KEY} label="Move docked Local AI task">
      <div class="flex items-center gap-1 border bg-surface p-1.5 shadow-xl">
        <span
          class="px-2 py-1 text-[0.625rem] font-semibold uppercase tracking-wide text-muted"
          aria-hidden="true"
          >{job.kind === 'uninstall'
            ? 'Uninstalls'
            : job.kind === 'install'
              ? 'Installs'
              : 'Updates'}</span
        >
        <span class="h-5 w-px bg-border"></span>
        <button
          class="relative flex h-8 w-8 items-center justify-center transition-colors hover:bg-elevated"
          {title}
          aria-label={title}
          onclick={onExpand}
        >
          <VendorIcon name="llama.cpp" id="llamacpp" size={16} />
          {#if jobExitCode === null}
            <span class="absolute -right-0.5 -top-0.5 h-2 w-2 bg-info" aria-hidden="true"></span>
          {:else if jobExitCode === 0}
            <CioCheckCircle
              size={10}
              class="absolute -right-1 -top-1 bg-surface text-success"
              aria-hidden="true"
            />
          {:else}
            <CioCrossCircle
              size={10}
              class="absolute -right-1 -top-1 bg-surface text-danger"
              aria-hidden="true"
            />
          {/if}
        </button>
        {#if finished}
          <span class="h-5 w-px bg-border"></span>
          <button
            class="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Close Local AI task"
            title="Close Local AI task"
            onclick={onClose}
          >
            <CioClose size={14} />
          </button>
        {/if}
      </div>
    </DockRow>
  {/snippet}

  <div class="overflow-hidden border bg-surface">
    <div class="flex items-center justify-between gap-3 border-b px-3 py-2">
      <div class="flex min-w-0 items-center gap-2">
        <VendorIcon name="llama.cpp" id="llamacpp" size={14} />
        <span class="truncate text-xs font-medium">llama.cpp</span>
        <span class="truncate font-mono text-[0.625rem] text-dimmed">
          brew {job.args.join(' ')}
        </span>
      </div>
      {#if jobCancelled && finished}
        <span class="shrink-0 text-[0.625rem] text-muted">Stopped</span>
      {:else if jobExitCode === null}
        <div class="flex shrink-0 items-center gap-2">
          <button
            class="px-2 py-1 text-xs text-danger transition-colors hover:bg-elevated disabled:opacity-50"
            title="Stop this process"
            aria-label="Stop this process"
            disabled={jobStopping}
            onclick={onStop}
          >
            {jobStopping ? 'Stopping…' : 'Stop'}
          </button>
          <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-info">
            <CioSpinner size={11} class="animate-spin" />
            {activeLabel(job.kind)}
          </span>
        </div>
      {:else if jobExitCode === 0}
        <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-success">
          <CioCheckCircle size={11} />
          {finishedLabel(job.kind)}
        </span>
      {:else}
        <span class="flex shrink-0 items-center gap-1 text-[0.625rem] font-medium text-danger">
          <CioCrossCircle size={11} /> Exited with code {jobExitCode}
        </span>
      {/if}
    </div>
    <div class="h-48 overflow-hidden">
      <ProviderLoginTerminal
        terminalId={job.terminalId}
        cancelled={jobCancelled}
        startingLabel={`Starting ${verb(job.kind)}…`}
        command={job.command}
        args={job.args}
        idleTimeoutMs={job.kind === 'install'
          ? 300_000
          : job.kind === 'update'
            ? 60_000
            : undefined}
        onExit={(exitCode) => onExit(exitCode)}
      />
    </div>
  </div>
</DockableModal>
