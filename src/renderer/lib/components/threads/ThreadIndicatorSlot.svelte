<script lang="ts">
  import RecordingIndicator from '$lib/components/speech/RecordingIndicator.svelte'
  import VoiceSendIndicator from '$lib/components/speech/VoiceSendIndicator.svelte'
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
{:else if indicator === 'transcribing-send'}
  <VoiceSendIndicator stage="send" label="Transcribing   will send when ready" />
{:else if indicator === 'transcribing-steer'}
  <VoiceSendIndicator stage="steer" label="Transcribing   will steer the running turn" />
{:else}
  <ComputerUseIndicator label="Agent using the computer" />
{/if}
