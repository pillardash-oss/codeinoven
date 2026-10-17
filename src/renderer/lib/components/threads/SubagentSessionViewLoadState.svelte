<script lang="ts">
  import CioSpinner from '$lib/components/icons/cio/CioSpinner.svelte'
  interface Props {
    loading: boolean
    /** True while the child session is still running. */
    busy: boolean
    /** True once this child streamed an event of its own. */
    liveStreamed: boolean
    loadError: string
    messageCount: number
    onRetry: () => void
  }

  let { loading, busy, liveStreamed, loadError, messageCount, onRetry }: Props = $props()
</script>

{#if (loading || busy) && messageCount === 0 && !liveStreamed}
  <div class="flex items-center justify-center gap-2 py-8 text-xs text-muted">
    <CioSpinner size={13} class="animate-spin text-info" />
    Loading sub-agent session…
  </div>
{:else if loadError && !busy && !liveStreamed}
  <div class="border border-danger/30 bg-danger/5 px-3 py-2.5">
    <p class="text-xs font-medium text-danger">Could not load the sub-agent session</p>
    <p class="mt-1 text-[0.6875rem] text-muted">{loadError}</p>
    <button
      type="button"
      class="mt-2 text-[0.625rem] font-medium text-info hover:underline"
      onclick={onRetry}
    >
      Try again
    </button>
  </div>
{/if}
