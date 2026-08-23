<script lang="ts">
  import { LoaderCircle, Mic, Square, TriangleAlert } from '@lucide/svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type { SpeechEditorSnapshot, SpeechEditorTarget } from '../../speech/editor-target'
  import { speechController } from '../../speech/speech-controller.svelte'

  interface Props {
    targetId: string
    getTarget: () => SpeechEditorTarget | null
    scope: SpeechScope
    disabled?: boolean
    class?: string
  }

  let { targetId, getTarget, scope, disabled = false, class: className = '' }: Props = $props()
  let preparedTarget: SpeechEditorTarget | null = null
  let preparedSnapshot: SpeechEditorSnapshot | null = null

  const belongsHere = $derived(speechController.isActiveTarget(targetId))
  const anotherTargetActive = $derived(
    speechController.state.state !== 'idle' &&
      speechController.state.state !== 'failed' &&
      !belongsHere
  )
  const action = $derived.by(() => {
    if (!belongsHere) return 'start' as const
    if (speechController.state.state === 'recording') return 'stop' as const
    if (speechController.state.state === 'failed') return 'retry' as const
    return 'wait' as const
  })
  const label = $derived.by(() => {
    if (action === 'stop') return 'Stop voice recording'
    if (action === 'retry') {
      return speechController.state.state === 'failed'
        ? `${speechController.state.message} Click to retry voice recording.`
        : 'Retry voice recording'
    }
    if (action === 'wait') {
      return speechController.state.state === 'requesting-permission'
        ? 'Requesting microphone permission'
        : speechController.state.state === 'stopping'
          ? 'Stopping voice recording'
          : 'Transcribing voice recording'
    }
    return 'Start voice recording'
  })

  function prepareTarget(): void {
    if (disabled || anotherTargetActive || action === 'stop' || action === 'wait') return
    preparedTarget = getTarget()
    preparedSnapshot = preparedTarget?.capture() ?? null
  }

  async function activate(): Promise<void> {
    if (disabled || anotherTargetActive || action === 'wait') return
    if (action === 'stop') {
      await speechController.stop()
      return
    }
    if (action === 'retry') speechController.resetFailure(targetId)
    const target = preparedTarget ?? getTarget()
    const snapshot = preparedSnapshot ?? target?.capture()
    preparedTarget = null
    preparedSnapshot = null
    if (!target) return
    await speechController.start(target, scope, snapshot)
  }

  function elapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1_000)
    const minutes = Math.floor(totalSeconds / 60)
    const seconds = String(totalSeconds % 60).padStart(2, '0')
    return `${minutes}:${seconds}`
  }
</script>

<button
  type="button"
  class="relative flex h-8 w-16 shrink-0 items-center justify-center gap-1.5 overflow-hidden rounded-lg border border-border bg-surface text-muted transition-colors hover:bg-elevated hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-45 {belongsHere &&
  speechController.state.state === 'recording'
    ? 'border-danger/50 bg-danger/10 text-danger'
    : ''} {className}"
  title={label}
  aria-label={label}
  aria-pressed={belongsHere && speechController.state.state === 'recording'}
  disabled={disabled || anotherTargetActive || action === 'wait'}
  onpointerdown={prepareTarget}
  onkeydown={(event) => {
    if (event.key === 'Enter' || event.key === ' ') prepareTarget()
  }}
  onclick={() => void activate()}
>
  {#if belongsHere && speechController.state.state === 'recording'}
    <span class="h-1.5 w-1.5 animate-pulse rounded-full bg-danger" aria-hidden="true"></span>
    <span class="font-mono text-[10px] font-semibold tabular-nums">
      {elapsed(speechController.state.elapsedMs)}
    </span>
    <Square size={11} aria-hidden="true" />
  {:else if belongsHere && speechController.state.state === 'failed'}
    <TriangleAlert size={14} aria-hidden="true" />
  {:else if belongsHere && speechController.state.state !== 'idle'}
    <LoaderCircle size={14} class="animate-spin" aria-hidden="true" />
  {:else}
    <Mic size={15} aria-hidden="true" />
  {/if}
</button>

<span class="sr-only" aria-live="polite">{belongsHere ? label : ''}</span>
