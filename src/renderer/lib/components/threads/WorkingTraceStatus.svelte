<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioCrossCircle from '@pdslng/cio-icon/CioCrossCircle.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  import type { OvenPrepareStep } from '$shared/types'

  interface Props {
    /** True when this trace was rehydrated from persisted state instead of a live run. */
    rehydrated: boolean
    /** True when this run belongs to another CodeInOven instance, which is where
     *  its live output and stop control are. */
    foreignRun?: boolean
    /** What the app is doing before the harness streams, e.g. preparing or
     *  cloning a remote checkout. */
    note?: string | null
    /** The parallel preparation steps behind that note, each with its own state. */
    steps?: OvenPrepareStep[] | null
  }

  let { rehydrated, foreignRun = false, note = null, steps = null }: Props = $props()

  /** The steps worth a row: an empty list is the same as no list at all, and the
   *  note line alone is what a single-step preparation has always shown. */
  const listedSteps = $derived(steps ?? [])
</script>

<!-- The trace's attribution lives in the header now, so this footer only carries
     a note the header cannot: a restored or foreign run, or a pre-harness step
     the harness has not started reporting yet. A plain live run shows nothing
     here. -->
<div class="flex flex-col gap-1">
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
    {#if foreignRun}
      <span class="flex min-w-0 shrink items-center gap-2 text-[0.625rem] text-info/80">
        <CioWindow size={11} class="shrink-0 text-info" />
        Running in another instance · showing last saved activity
      </span>
    {:else if rehydrated}
      <span class="flex min-w-0 shrink items-center gap-2 text-[0.625rem] text-info/80">
        <CioRefresh size={11} class="shrink-0 text-info" />
        Showing last saved activity · live run not confirmed
      </span>
    {:else if note}
      <span class="flex min-w-0 shrink items-center gap-2">
        <CioSpinner size={12} class="shrink-0 animate-spin text-info" />
        <span class="min-w-0 truncate text-[0.625rem] text-dimmed">{note}</span>
      </span>
    {/if}
  </div>

  <!-- Preparation the app does on the Oven before the harness streams. The steps
       run at the same time, so each carries its own state: a spinner while it
       works, a tick once done, a red mark if it failed, and quiet text while it
       waits for the Oven. -->
  {#if listedSteps.length > 0}
    <ul class="flex flex-col gap-0.5">
      {#each listedSteps as step (step.id)}
        <li class="flex min-w-0 items-center gap-1.5 text-[0.625rem]">
          {#if step.status === 'running'}
            <CioSpinner size={11} class="shrink-0 animate-spin text-info" />
            <span class="sr-only">Running</span>
          {:else if step.status === 'done'}
            <CioCheck size={11} class="shrink-0 text-success" />
            <span class="sr-only">Done</span>
          {:else if step.status === 'failed'}
            <CioCrossCircle size={11} class="shrink-0 text-danger" />
            <span class="sr-only">Failed</span>
          {:else}
            <span class="size-1.5 shrink-0 bg-dimmed/60" aria-hidden="true"></span>
            <span class="sr-only">Waiting</span>
          {/if}
          <span class="min-w-0 truncate {step.status === 'waiting' ? 'text-dimmed' : 'text-muted'}">
            {step.label}
          </span>
          {#if step.detail}
            <span class="min-w-0 truncate text-[0.5625rem] text-dimmed">{step.detail}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
