<script lang="ts">
  import { CircleAlert, LoaderCircle, Pause, Play, Volume2 } from '@lucide/svelte'
  import { speechController } from '../../speech/speech-controller.svelte'

  interface Props {
    messageId: string
    markdown: string
    disabled?: boolean
  }

  let { messageId, markdown, disabled = false }: Props = $props()
  const state = $derived(speechController.playback)
  const ownsSession = $derived('messageId' in state && state.messageId === messageId)
  const title = $derived.by(() => {
    if (!ownsSession) return 'Read response aloud'
    if (state.state === 'preparing') return 'Preparing spoken response'
    if (state.state === 'playing') return 'Pause spoken response'
    if (state.state === 'paused') return 'Resume spoken response'
    if (state.state === 'failed') return 'Retry spoken response'
    return 'Read response aloud'
  })

  function activate(): void {
    void speechController.togglePlayback(messageId, markdown)
  }
</script>

<button
  type="button"
  class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-info focus-visible:outline-none disabled:opacity-40"
  {title}
  aria-label={title}
  {disabled}
  onclick={activate}
>
  {#if ownsSession && state.state === 'preparing'}
    <LoaderCircle size={12} class="animate-spin" aria-hidden="true" />
  {:else if ownsSession && state.state === 'playing'}
    <Pause size={12} aria-hidden="true" />
  {:else if ownsSession && state.state === 'paused'}
    <Play size={12} aria-hidden="true" />
  {:else if ownsSession && state.state === 'failed'}
    <CircleAlert size={12} aria-hidden="true" />
  {:else}
    <Volume2 size={12} aria-hidden="true" />
  {/if}
</button>
