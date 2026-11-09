<script lang="ts">
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import { APP_SLUG } from '$shared/brand'
  import { ASSISTANT_SPACE_ID, assistantIsDon } from '$shared/types'
  import type { Assistant } from '$shared/types'
  import type { SpeechScope } from '$shared/speech/types'
  import {
    ASSISTANT_ICON_FALLBACK_COLOR,
    AssistantDefaultIcon,
    assistantAccentColor,
    getAssistantIcon
  } from '$lib/assistant-icons'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import RichMarkdownEditor from '$lib/components/shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '$lib/components/speech/VoiceInputButton.svelte'
  import DockRow from '$lib/components/ui/DockRow.svelte'
  import DockableModal from '$lib/components/ui/DockableModal.svelte'
  import { donListening } from '$lib/don-listening.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import { speechController } from '$lib/speech/speech-controller.svelte'
  import type { SpeechEditorTarget } from '$lib/speech/editor-target'
  import { sendThreadMessageHeadless } from '$lib/stores/thread-delivery'
  import { logRendererError } from '$lib/system/renderer-logger'

  /**
   * The surface the three-tap dictation gesture raises: Don listening.
   *
   * The gesture can be made anywhere in the window, so it needs a place to put
   * what the user says that is not the composer of whichever thread happens to
   * be open: this panel is that place. Dictation lands in its markdown editor,
   * the mic in its footer records straight into it, and Send hands the finished
   * text to Don's own thread as a user turn.
   *
   * It is a dockable panel rather than a dialog because the user may want to
   * look at something else while composing, and because the app stays usable
   * behind it. It is mounted at the app root (see `App.svelte`), so it outlives
   * every view the gesture reaches from.
   */
  const STORAGE_KEY = `${APP_SLUG}.don.listening`
  const EDITOR_ID = 'don-listening-editor'
  /** Names this panel's editor to the speech controller, so a recording it owns
   *  is recognised as its own and a transcript lands here, not somewhere behind. */
  const SPEECH_TARGET_ID = 'don-listening'
  /**
   * Don is a floating panel over whatever the user was doing, so its mic outranks
   * the surfaces behind it when the global dictation shortcut picks a recorder.
   */
  const VOICE_PRIORITY = 9

  /** The panel is not a persistent dock: it is raised by a gesture and lives only
   *  while the user composes into it, so its collapse state is local. */
  let minimized = $state(false)
  let value = $state('')
  let richEditor = $state<RichMarkdownEditor>()
  /** Don's permanent thread, read once per open. Null while it loads and when
   *  Don is not ready, which is what disables Send. */
  let donThreadId = $state<string | null>(null)
  /** Don's own assistant row, so the panel wears Don's mark and accent colour. */
  let donAssistant = $state<Assistant | null>(null)
  let donIconUrl = $state<string | null>(null)
  let sending = $state(false)
  let sendError = $state<string | null>(null)

  /** Don's accent colour and mark: the real assistant row when it is loaded,
   *  otherwise the app's own assistant mark. */
  const donMark = $derived(donAssistant ? getAssistantIcon(donAssistant, donIconUrl) : null)
  const donColor = $derived(
    donAssistant ? assistantAccentColor(donAssistant) : ASSISTANT_ICON_FALLBACK_COLOR
  )

  const canSend = $derived(donThreadId !== null && value.trim().length > 0 && !sending)
  const sendLabel = $derived(
    donThreadId === null
      ? 'Don is not ready yet, so there is nothing to send to'
      : `Send to Don (${keymapState.labelFor('ui-modal-primary-action')})`
  )

  /** The live state of this panel's own recording, in plain words. */
  const speakingHere = $derived(speechController.isActiveTarget(SPEECH_TARGET_ID))
  const transcribingHere = $derived(speechController.isTranscribingTarget(SPEECH_TARGET_ID))
  const listeningState = $derived.by((): string => {
    const speech = speechController.state
    if (speakingHere) {
      if (speech.state === 'starting') return 'Opening the microphone'
      if (speech.state === 'recording') return 'Recording'
      if (speech.state === 'stopping') return 'Finishing the recording'
      if (speech.state === 'failed') return speech.message
    }
    if (transcribingHere) return 'Transcribing'
    return 'Waiting for your voice'
  })

  /** A panel that belongs to no thread yet: its dictation has no thread scope. */
  const speechScope: SpeechScope = { kind: 'global' }

  function getSpeechTarget(): SpeechEditorTarget | null {
    return richEditor?.speechEditorTarget(SPEECH_TARGET_ID) ?? null
  }

  /**
   * Don's thread and mark, read when the panel mounts.
   *
   * The panel is mounted by `App.svelte` only while it is open, so mounting is
   * the open event, and a fresh read is what keeps a thread created or restored
   * after the last open from being missed.
   */
  async function loadDon(): Promise<void> {
    try {
      const [donThread, assistantList] = await Promise.all([
        invoke('assistant:donThread'),
        invoke('assistant:list')
      ])
      donThreadId = donThread?.threadId ?? null
      const don = assistantList.find((assistant) => assistantIsDon(assistant)) ?? null
      donAssistant = don
      if (!don) return
      try {
        donIconUrl = await invoke('assistant:getIcon', don.id)
      } catch {
        // The mark falls back to the app's assistant icon: a missing icon file is
        // cosmetic and must not cost the panel its thread.
      }
    } catch (cause) {
      // Don lives in main, and a failure here reads as "not ready", which is the
      // honest state for the panel: it can still take dictation, but not send.
      logRendererError('Could not read the thread Don listens on.', cause)
      donThreadId = null
    }
  }

  /**
   * Hand the composed text to Don's thread as a user turn, then close.
   *
   * A send targets a thread by project and id, and Don's thread is not in the
   * thread the user is looking at: it lives in the assistant space, which is
   * exactly where the `assistant:donThread` handler reads it from. The headless
   * delivery path is the one every surface with no mounted conversation uses, so
   * the turn is queued and steered by the same rules as the thread view.
   */
  async function send(): Promise<void> {
    const text = value.trim()
    const threadId = donThreadId
    if (!text || !threadId || sending) return
    sending = true
    sendError = null
    try {
      await sendThreadMessageHeadless(ASSISTANT_SPACE_ID, threadId, { text })
      value = ''
      donListening.close()
    } catch (cause) {
      logRendererError('Could not send this message to Don.', cause)
      // The draft stays: a failed send is not a reason to lose what was dictated.
      sendError = 'Could not reach Don. Your text is still here.'
    } finally {
      sending = false
    }
  }

  /**
   * The panel's primary action.
   *
   * The dockable shell resolves a footer button on its own, but the chord is
   * claimed here so Cmd/Ctrl+Enter can never fall through to the mic while Send
   * is disabled: with nothing to send, the shortcut does nothing.
   */
  function runPrimaryAction(): boolean {
    if (canSend) void send()
    return true
  }

  void loadDon()
</script>

<DockableModal
  open={donListening.isOpen}
  title="Listening"
  {minimized}
  closable
  onMinimize={() => (minimized = true)}
  onClose={() => donListening.close()}
  storageKey={STORAGE_KEY}
  layer="top"
  flushBody
  defaultHeight={460}
  dragLabel="Drag to move the Don Listening panel"
  onPrimaryAction={runPrimaryAction}
>
  {#snippet headerPrefix()}
    <!-- Don's own mark, so the panel reads as Don rather than as a generic
         listening box. The real assistant row supplies the icon and colour when
         it is loaded; before that the app's assistant mark stands in. -->
    <span class="flex items-center" style="color: {donColor}">
      {#if donMark}
        <img
          src={donMark}
          alt=""
          aria-hidden="true"
          class="h-4 w-4 object-contain"
          draggable="false"
        />
      {:else}
        <AssistantDefaultIcon size={ICON_SIZE.row} aria-hidden="true" />
      {/if}
    </span>
  {/snippet}

  {#snippet headerActions()}
    <span class="mr-1 text-xs text-muted" role="status">{listeningState}</span>
  {/snippet}

  {#snippet dock()}
    <DockRow storageKey={STORAGE_KEY} label="Move the docked Don Listening panel">
      <div class="flex items-center gap-1 border bg-surface p-1.5 shadow-xl">
        <button
          type="button"
          class="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title="Show Don Listening again"
          aria-label="Show Don Listening again"
          onclick={() => (minimized = false)}
        >
          <CioAudioLines size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
          <span class="flex min-w-0 flex-col">
            <span class="text-xs font-medium leading-tight text-foreground">Listening</span>
            <span class="max-w-40 truncate text-xs leading-tight text-muted">Don</span>
          </span>
        </button>
      </div>
    </DockRow>
  {/snippet}

  {#snippet footer()}
    <!-- Cancel first: the shell hands the first dismiss affordance `mr-auto`, so
         it holds the far bottom left while the mic and Send stay on the right. -->
    <button
      type="button"
      class="px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
      data-modal-dismiss
      title="Close without sending"
      onclick={() => donListening.close()}
    >
      Cancel
    </button>
    <VoiceInputButton
      targetId={SPEECH_TARGET_ID}
      getTarget={getSpeechTarget}
      scope={speechScope}
      triggerPriority={VOICE_PRIORITY}
      class="h-7 w-7 text-dimmed"
    />
    <button
      type="button"
      class="flex items-center gap-1.5 bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-45"
      data-modal-primary
      disabled={!canSend}
      title={sendLabel}
      aria-label={sendLabel}
      onclick={() => void send()}
    >
      <CioArrowUp size={ICON_SIZE.inline} aria-hidden="true" />
      {sending ? 'Sending' : 'Send'}
    </button>
  {/snippet}

  <!-- `data-voice-trigger-root` makes this panel one voice region: the mic in the
       footer and the editor it records into are the same surface, so a recording
       started from the shortcut belongs here while the caret is here. -->
  <div class="flex min-h-0 flex-1 flex-col" data-voice-trigger-root>
    {#if sendError}
      <p class="shrink-0 border-b px-4 py-2 text-xs text-danger" role="alert">{sendError}</p>
    {/if}
    <RichMarkdownEditor
      bind:this={richEditor}
      id={EDITOR_ID}
      bind:value
      containerClass="flex min-h-0 flex-1 flex-col"
      class="min-h-0 flex-1 overflow-y-auto px-3.5 pt-3 pb-3 text-sm leading-5 text-foreground outline-none"
      placeholder="Tell Don what you want done"
      ariaLabel="Message for Don"
      autofocus
      onSubmit={() => void send()}
    />
  </div>
</DockableModal>
