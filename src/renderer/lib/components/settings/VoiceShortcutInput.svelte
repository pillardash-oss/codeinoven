<script lang="ts">
  import { RotateCcw } from '@lucide/svelte'
  import {
    DEFAULT_VOICE_RECORDING_SHORTCUT,
    MODIFIER_KEY_CODES,
    type VoiceRecordingShortcut
  } from '../../../../lib/speech/types'
  import {
    beginVoiceShortcutCapture,
    describeVoiceRecordingShortcut,
    endVoiceShortcutCapture
  } from '../../speech/voice-shortcut'

  interface Props {
    value?: VoiceRecordingShortcut
    onchange: (next: VoiceRecordingShortcut) => void
  }

  let { value, onchange }: Props = $props()

  let listening = $state(false)
  let rejected = $state(false)

  const binding = $derived(value ?? DEFAULT_VOICE_RECORDING_SHORTCUT)
  const isDefault = $derived(
    binding.code === DEFAULT_VOICE_RECORDING_SHORTCUT.code &&
      binding.ctrl === DEFAULT_VOICE_RECORDING_SHORTCUT.ctrl &&
      binding.meta === DEFAULT_VOICE_RECORDING_SHORTCUT.meta &&
      binding.alt === DEFAULT_VOICE_RECORDING_SHORTCUT.alt &&
      binding.shift === DEFAULT_VOICE_RECORDING_SHORTCUT.shift &&
      binding.doubleTap === DEFAULT_VOICE_RECORDING_SHORTCUT.doubleTap
  )

  function startListening(): void {
    rejected = false
    listening = true
  }

  function stopListening(): void {
    listening = false
  }

  /** Bare modifiers become double-tap bindings; anything else needs a real
   *  modifier chord or a function key so ordinary typing can never be bound. */
  function buildBinding(event: KeyboardEvent): VoiceRecordingShortcut | null {
    if (MODIFIER_KEY_CODES.has(event.code)) {
      return {
        code: event.code,
        ctrl: false,
        meta: false,
        alt: false,
        shift: false,
        doubleTap: true
      }
    }
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey
    if (!hasModifier && !/^F\d{1,2}$/.test(event.code)) return null
    return {
      code: event.code,
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      alt: event.altKey,
      shift: event.shiftKey,
      doubleTap: false
    }
  }

  // While capturing we own the keyboard: swallow every keydown (the detector
  // also stands down via its capture-depth guard) so nothing else reacts.
  $effect(() => {
    if (!listening) return
    beginVoiceShortcutCapture()
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        stopListening()
        return
      }
      if (event.repeat) return
      const built = buildBinding(event)
      if (!built) {
        rejected = true
        return
      }
      onchange(built)
      stopListening()
    }
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', stopListening)
    return () => {
      endVoiceShortcutCapture()
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', stopListening)
    }
  })
</script>

<div class="flex shrink-0 items-center gap-1.5">
  <button
    type="button"
    class="min-w-40 rounded-lg border px-3 py-2 text-xs outline-none transition-colors focus:border-primary {listening
      ? 'border-primary bg-primary/5 text-dimmed'
      : 'border-border bg-elevated text-foreground hover:border-primary/60'}"
    title="Change the voice recording shortcut"
    aria-label="Change the voice recording shortcut"
    onclick={startListening}
  >
    {#if listening}
      {rejected ? 'Use Ctrl/Alt/Cmd with a key, or a function key…' : 'Press keys…'}
    {:else}
      {describeVoiceRecordingShortcut(binding)}
    {/if}
  </button>
  {#if !isDefault}
    <button
      type="button"
      class="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-elevated text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      title="Reset the voice recording shortcut to the default"
      aria-label="Reset voice recording shortcut to default"
      onclick={() => onchange(DEFAULT_VOICE_RECORDING_SHORTCUT)}
    >
      <RotateCcw size={13} aria-hidden="true" />
    </button>
  {/if}
</div>
