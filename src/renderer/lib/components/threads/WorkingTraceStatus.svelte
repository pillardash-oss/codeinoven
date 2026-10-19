<script lang="ts">
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioWindow from '@pdslng/cio-icon/CioWindow.svelte'
  interface Props {
    /** True when this trace was rehydrated from persisted state instead of a live run. */
    rehydrated: boolean
    /** True when this run belongs to another CodeInOven instance, which is where
     *  its live output and stop control are. */
    foreignRun?: boolean
    /** What the app is doing before the harness streams, e.g. preparing or
     *  cloning a remote checkout. */
    note?: string | null
  }

  let { rehydrated, foreignRun = false, note = null }: Props = $props()
</script>

<!-- The trace's attribution lives in the header now, so this footer only carries
     a note the header cannot: a restored or foreign run, or a pre-harness step
     the harness has not started reporting yet. A plain live run shows nothing
     here. -->
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
