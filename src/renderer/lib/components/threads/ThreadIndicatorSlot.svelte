<script lang="ts">
  import RecordingIndicator from '$lib/components/speech/RecordingIndicator.svelte'
  import WaveBars from '$lib/components/speech/WaveBars.svelte'
  import ComputerUseIndicator from './ComputerUseIndicator.svelte'
  import type { ThreadIndicator } from './thread-indicator'

  interface Props {
    /** Which action owns the row's indicator slot right now. */
    indicator: ThreadIndicator
  }

  let { indicator }: Props = $props()
</script>

{#if indicator === 'recording'}
  <RecordingIndicator label="Listening" />
{:else if indicator === 'speaking'}
  <RecordingIndicator label="Speaking" tone="speech" />
{:else if indicator === 'transcribing'}
  <WaveBars label="Transcribing" />
{:else}
  <ComputerUseIndicator label="Agent using the computer" />
{/if}
