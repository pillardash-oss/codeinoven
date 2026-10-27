<script lang="ts">
  import RecordingIndicator from '$lib/components/speech/RecordingIndicator.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  let { label, recording = false }: { label: string; recording?: boolean } = $props()
</script>

<span
  class="absolute -bottom-2 {recording
    ? '-left-2'
    : '-right-2'} flex h-3.5 w-3.5 items-center justify-center border border-border bg-elevated text-info shadow-sm"
  role="status"
  aria-label={`${label} ${recording ? 'is recording' : 'is playing audio'}`}
  title={`${label} ${recording ? 'is recording' : 'is playing audio'}`}
>
  {#if recording}
    <RecordingIndicator decorative />
  {:else}
    <CioVolume size={9} strokeWidth={2.6} aria-hidden="true" />
  {/if}
</span>
