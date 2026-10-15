<script lang="ts">
  import { KeyRound, ShieldCheck } from '@lucide/svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import { slide } from 'svelte/transition'
  import { formatKeyCombo } from '$lib/keymap/keymap'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardCloseButton from '../shared/CardCloseButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardStepper from '../shared/CardStepper.svelte'
  import { cardFrameClass } from '../shared/card-frame'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import { formatRemaining } from '../shared/card-timer'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import SecretVisibilityButton from '../shared/SecretVisibilityButton.svelte'
  import AgentCardChatActions from './AgentCardChatActions.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type {
    AgentQuestion,
    AgentSecretSubmission,
    PendingAgentQuestionRequest
  } from '$shared/types'

  interface Props {
    request: PendingAgentQuestionRequest
    /** Sends the pasted values to the main process; they never enter the transcript. */
    onSubmit: (requestId: string, secrets: AgentSecretSubmission[]) => Promise<void>
    onDismiss: (requestId: string) => Promise<void>
    scope: SpeechScope
    /** Opens the explain side chat for the current secret, pausing its timeout. */
    onExplain?: (requestId: string, question: AgentQuestion) => void
    /** Opens a quick chat for the current secret, pausing its timeout. */
    onQuickChat?: (requestId: string, question: AgentQuestion) => void
    /**
     * Holds the request countdown while the user works on the card: filling the
     * value in, opening a temporary chat, or writing an alternative. Resolves
     * once the main process cleared the deadline, and rejects when it could not,
     * so the card can retry on the next interaction.
     */
    onPause?: (requestId: string, questionIndex: number) => Promise<void>
  }

  let { request, onSubmit, onDismiss, scope, onExplain, onQuickChat, onPause }: Props = $props()

  // The parent keys this component by request id, so these drafts belong to one
  // authoritative pending request for the lifetime of the component.
  let currentIndex = $state(0)
  // svelte-ignore state_referenced_locally
  let values = $state<string[]>(request.questions.map(() => ''))
  // Each secret is answered on its own: a value, or an instruction that lets the
  // main process reuse one the device already holds. One card can mix the two.
  // svelte-ignore state_referenced_locally
  let alternatives = $state<string[]>(request.questions.map(() => ''))
  // svelte-ignore state_referenced_locally
  let alternativeModes = $state<boolean[]>(request.questions.map(() => false))
  let revealedIndex = $state<number | null>(null)
  let working = $state(false)
  let actionError = $state('')
  let folded = $state(false)
  let alternativeEditor = $state<RichMarkdownEditor>()

  let total = $derived(request.questions.length)
  let question = $derived(request.questions[currentIndex])
  let currentRevealed = $derived(revealedIndex === currentIndex)
  let showingAlternative = $derived(alternativeModes[currentIndex] ?? false)

  /** Whether one entry is answerable: a pasted value or a written instruction. */
  function entryAnswered(index: number): boolean {
    if (alternativeModes[index]) return (alternatives[index] ?? '').trim().length > 0
    return (values[index] ?? '').trim().length > 0
  }

  let filledCount = $derived(request.questions.filter((_, index) => entryAnswered(index)).length)
  let allFilled = $derived(filledCount === total)
  let currentAnswered = $derived(entryAnswered(currentIndex))
  // The close in the head ends the whole request, never the entry on screen.
  let dismissTitle = $derived(total > 1 ? 'Dismiss all secrets' : 'Dismiss this request')
  // The send key resolved through the user's keymap overrides, so the stepper's
  // forward arrow advertises whichever combination advances the card.
  let advanceShortcutLabel = $derived(formatKeyCombo(keymapState.keysFor('chat-send')))
  // The request carries its own deadline, so the countdown is the same one the
  // main process is running: the card closes when it reaches zero. Time is an
  // external system, so it is subscribed to rather than tracked in an effect.
  const subscribeToClock = createSubscriber((update) => {
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  })
  let remainingMs = $derived.by(() => {
    if (request.expiresAt === undefined) return null
    subscribeToClock()
    return Math.max(0, request.expiresAt - Date.now())
  })
  // A secret card carries no deadline only while the main process is holding it:
  // the user started filling the card in, so nothing counts down under their
  // hands. Both the label and the tooltip follow what main actually holds.
  let timerPaused = $derived(remainingMs === null && request.interactedQuestionIndexes.length > 0)
  let remainingLabel = $derived.by(() => {
    if (remainingMs !== null) return formatRemaining(remainingMs)
    return timerPaused ? 'Paused' : 'No deadline'
  })
  // The chip only claims urgency while the clock is running and the window is
  // nearly gone; "No deadline" is a state, not a warning.
  let timerTone = $derived<'default' | 'paused' | 'urgent'>(
    remainingMs === null ? 'paused' : remainingMs <= 60_000 ? 'urgent' : 'default'
  )
  let timerTitle = $derived(
    remainingMs === null
      ? timerPaused
        ? 'The countdown is paused while you fill this card in'
        : 'This request has no deadline'
      : 'The card closes when the time runs out; ask the agent again for a new one'
  )
  /** Id of the current entry's alternative editor, unique per entry. */
  const alternativeTargetId = $derived(`secret-alternative-${request.requestId}-${currentIndex}`)
  /**
   * Plain-text form of the reuse note that sits under the alternative field.
   * The note is clamped to two lines to keep the card compact, so this is the
   * full wording exposed through its tooltip.
   */
  let alternativeNote = $derived(
    `No value is stored for this secret. Whatever the device already holds for ${
      question.secretEnvironmentVariable ? `$${question.secretEnvironmentVariable}` : 'this secret'
    } is reused from your encrypted vault and handed to the agent, and your instruction reaches it as written.`
  )

  function alternativeSpeechTarget() {
    return alternativeEditor?.speechEditorTarget(alternativeTargetId) ?? null
  }

  /**
   * The deadline the user has already paused, so a typed or pasted value costs
   * one call instead of one call per keystroke. The main process hands the card
   * a fresh window once the user goes inactive, and the next interaction pauses
   * that window in turn.
   */
  let pausedDeadline: number | null = null

  /**
   * Hold the countdown the moment the user starts working on the card: a value
   * must never be cut off mid-paste, and nothing can answer a secret for them.
   * Best-effort, so the interaction that asked for the pause still happens; the
   * next interaction retries a pause that did not land.
   */
  function pauseCountdown(): void {
    const deadline = request.expiresAt
    if (!onPause || working || deadline === undefined || pausedDeadline === deadline) return
    pausedDeadline = deadline
    void onPause(request.requestId, currentIndex).catch(() => {
      if (pausedDeadline === deadline) pausedDeadline = null
    })
  }

  /**
   * Switch the current entry between a pasted value and an instruction. The
   * countdown is held either way: both are the user working on the card.
   */
  function toggleAlternativeMode(): void {
    pauseCountdown()
    alternativeModes[currentIndex] = !alternativeModes[currentIndex]
  }

  /**
   * Open a temporary chat for the current secret. The countdown is paused first
   * (the same interaction the question card makes) so the card cannot expire
   * while the user reads the chat.
   */
  function openSecretChat(onOpen: (requestId: string, question: AgentQuestion) => void): void {
    if (working) return
    pauseCountdown()
    onOpen(request.requestId, question)
  }

  /**
   * Move to the next entry, or submit when the current one is the last. Used by
   * the footer button, by Cmd/Ctrl+Enter in the alternative editor, and by the
   * same combination in the value field.
   */
  function advance(): void {
    if (working || !currentAnswered) return
    if (currentIndex < total - 1) {
      currentIndex += 1
      return
    }
    void handleSubmit()
  }

  /**
   * The value field's own send shortcut, read from the keymap like every other
   * keyboard action in the app: the same key that advances the question card
   * moves to the next secret here, and submits on the last one, so a whole
   * request can be answered from the keyboard. A plain input has no editor to
   * route it, so the field reports it itself.
   */
  function handleValueKeydown(event: KeyboardEvent): void {
    if (event.isComposing || !keymapState.matches('chat-send', event)) return
    event.preventDefault()
    advance()
  }

  function toggleReveal(): void {
    revealedIndex = currentRevealed ? null : currentIndex
  }

  function goPrev(): void {
    if (currentIndex > 0) currentIndex -= 1
  }

  async function handleSubmit(): Promise<void> {
    if (working || !allFilled) return
    const secrets: AgentSecretSubmission[] = []
    for (const [index, entry] of request.questions.entries()) {
      const secretId = entry.secretId
      if (!secretId) {
        actionError =
          'This request is missing a secret identifier. Dismiss it and ask the agent again.'
        return
      }
      if (alternativeModes[index]) {
        secrets.push({ secretId, alternative: (alternatives[index] ?? '').trim() })
      } else {
        secrets.push({ secretId, value: (values[index] ?? '').trim() })
      }
    }
    working = true
    actionError = ''
    try {
      await onSubmit(request.requestId, secrets)
    } catch (error) {
      working = false
      actionError = error instanceof Error ? error.message : 'The secret could not be stored.'
    }
  }

  async function handleDismiss(): Promise<void> {
    if (working) return
    working = true
    actionError = ''
    try {
      await onDismiss(request.requestId)
    } catch (error) {
      working = false
      actionError = error instanceof Error ? error.message : 'The request could not be discarded.'
    }
  }
</script>

<section
  out:slide={dismissSlide()}
  class={cardFrameClass('replace', 'overflow-hidden')}
  aria-label="Agent secret request"
>
  <!-- The card that takes the composer's place while the agent waits for a
     credential: what it needs, the field, and the two actions that end it. -->
  <CardHead
    icon={KeyRound}
    title={question.header ?? 'Secret'}
    chip={{
      text: remainingLabel,
      tone: timerTone,
      title: timerTitle,
      label: timerPaused ? 'The countdown is paused' : `Time remaining: ${remainingLabel}`
    }}
    foldLabel="secret request"
    bind:folded
  >
    {#snippet actions()}
      <AgentCardChatActions
        onExplain={onExplain ? () => openSecretChat(onExplain) : undefined}
        onQuickChat={onQuickChat ? () => openSecretChat(onQuickChat) : undefined}
        subject="secret request"
        disabled={working}
      />
    {/snippet}
    {#snippet controls()}
      <CardCloseButton
        title={dismissTitle}
        disabled={working}
        onclick={() => void handleDismiss()}
      />
    {/snippet}
  </CardHead>

  {#if !folded}
    <div transition:slide={foldSlide()}>
      <div class="space-y-3 p-4">
        <div class="space-y-1">
          <!-- Card-scale markdown: the same renderer the transcript uses, sized by
             the text utility on the surface around it. -->
          <div class="text-sm text-foreground">
            <MarkdownView text={question.prompt} class="markdown-body-card" />
          </div>
          {#if question.description}
            <div class="text-xs text-muted">
              <MarkdownView text={question.description} class="markdown-body-card" />
            </div>
          {/if}
        </div>

        {#key currentIndex}
          {#if showingAlternative}
            <div class="space-y-1.5">
              <label class="block text-xs font-medium text-muted" for={alternativeTargetId}>
                Alternative instruction
              </label>
              <div class="flex items-start gap-2">
                <RichMarkdownEditor
                  bind:this={alternativeEditor}
                  id={alternativeTargetId}
                  bind:value={alternatives[currentIndex]}
                  autofocus
                  disabled={working}
                  placeholder="Say what the agent should use instead, or name the variable you already provided…"
                  onValueChange={pauseCountdown}
                  class="min-h-20 w-full resize-y overflow-y-auto  border bg-elevated px-3.5 pt-3 pb-2 text-sm leading-5 text-foreground outline-none transition-colors focus:border-primary disabled:opacity-50"
                  containerClass="min-w-0 flex-1"
                  ariaLabel="Alternative instruction"
                  onSubmit={advance}
                />
                <VoiceInputButton
                  targetId={alternativeTargetId}
                  getTarget={alternativeSpeechTarget}
                  {scope}
                  disabled={working}
                />
              </div>
              <p class="line-clamp-2 text-xs text-dimmed" title={alternativeNote}>
                No value is stored for this secret. Whatever the device already holds for
                {#if question.secretEnvironmentVariable}
                  <span class="font-mono text-foreground"
                    >${question.secretEnvironmentVariable}</span
                  >
                {:else}
                  this secret
                {/if}
                is reused from your encrypted vault and handed to the agent, and your instruction reaches
                it as written.
              </p>
            </div>
          {:else}
            <div class="space-y-1.5">
              <label
                class="block text-xs font-medium text-muted"
                for={`secret-value-${request.requestId}-${currentIndex}`}
              >
                {allFilled ? 'Value' : 'Paste the value'}
              </label>
              <div class="relative">
                <span
                  class="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-dimmed"
                  aria-hidden="true"
                >
                  <KeyRound size={14} />
                </span>
                <input
                  id={`secret-value-${request.requestId}-${currentIndex}`}
                  class="h-10 w-full border bg-elevated pr-10 pl-9 font-mono text-sm text-foreground outline-none transition-colors focus:border-primary disabled:opacity-50"
                  type={currentRevealed ? 'text' : 'password'}
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  disabled={working}
                  placeholder="Paste the value"
                  bind:value={values[currentIndex]}
                  oninput={pauseCountdown}
                  onkeydown={handleValueKeydown}
                />
                <div class="absolute top-1/2 right-1 -translate-y-1/2">
                  <SecretVisibilityButton
                    revealed={currentRevealed}
                    disabled={working}
                    title={currentRevealed ? 'Hide the value' : 'Show the value'}
                    onclick={toggleReveal}
                  />
                </div>
              </div>
              {#if question.secretEnvironmentVariable}
                <p class="text-xs text-dimmed">
                  Available to the agent as
                  <span class="font-mono text-foreground"
                    >${question.secretEnvironmentVariable}</span
                  >
                </p>
              {/if}
            </div>
          {/if}
        {/key}

        {#if actionError}
          <p class="bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {actionError}
          </p>
        {/if}
      </div>
    </div>
  {/if}

  <CardFoot class="secret-card-footer">
    {#snippet left()}
      <CardStepper
        subject="secret"
        index={currentIndex}
        {total}
        advanceHint={advanceShortcutLabel}
        disabled={working}
        onPrev={goPrev}
        onNext={advance}
      />
      <p
        class="flex min-w-0 items-center gap-1.5 text-xs text-muted"
        title="Secrets are stored in your encrypted vault and are never sent to the agent"
        aria-label="Secrets are stored in your encrypted vault and are never sent to the agent"
      >
        <ShieldCheck size={13} class="shrink-0 text-primary" />
        <span class="agent-card-footer-note-text min-w-0 truncate">Secrets are safe</span>
      </p>
      <CardButton
        label={showingAlternative ? 'Use a value instead' : 'Provide alternative'}
        title={showingAlternative
          ? 'Answer with a value instead of an instruction'
          : 'Provide an alternative instead'}
        variant="secondary"
        disabled={working}
        onclick={toggleAlternativeMode}
      />
    {/snippet}
    {#snippet right()}
      <CardButton
        label={working ? 'Storing…' : 'Submit'}
        title="Store the secret and answer the agent"
        icon={ShieldCheck}
        variant="primary"
        loading={working}
        disabled={working || !allFilled}
        onclick={() => void handleSubmit()}
      />
    {/snippet}
  </CardFoot>
</section>

<style>
  /*
    Same footer contract as the question card: the row is the query container so
    the note gives way before the card's own controls. The shield keeps its
    tooltip when the note text hides.
  */
  .secret-card-footer {
    container: agent-card-footer / inline-size;
  }

  @container agent-card-footer (max-width: 40rem) {
    .agent-card-footer-note-text {
      display: none;
    }
  }
</style>
