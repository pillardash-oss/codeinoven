<script lang="ts">
  import CioClipboardList from '@codeio/icon/CioClipboardList.svelte'
  import CioClose from '@codeio/icon/CioClose.svelte'
  import CioPaperclip from '@codeio/icon/CioPaperclip.svelte'
  import CioSend from '@codeio/icon/CioSend.svelte'
  import TriangleQuestionMark from '$lib/components/icons/cio/TriangleQuestionMark.svelte'
  import { fly, slide } from 'svelte/transition'
  import { onDestroy } from 'svelte'
  import { SvelteSet, createSubscriber } from 'svelte/reactivity'
  import { invoke } from '$lib/ipc.svelte'
  import { formatKeyCombo } from '$lib/keymap/keymap'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardCloseButton from '../shared/CardCloseButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardOption from '../shared/CardOption.svelte'
  import CardStepper from '../shared/CardStepper.svelte'
  import { cardFrameClass } from '../shared/card-frame'
  import {
    dismissSlide,
    foldSlide,
    playEntryStep,
    rowArrive,
    type StepDirection
  } from '../shared/card-motion'
  import { formatRemaining } from '../shared/card-timer'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import QuestionSpeechControls from '../speech/QuestionSpeechControls.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type {
    AgentQuestion,
    AgentQuestionOption,
    PendingAgentQuestionRequest,
    ProviderCatalog,
    ThreadSettings
  } from '$shared/types'
  import EngineeringModelSwitch from '../shared/EngineeringModelSwitch.svelte'
  import AgentCardChatActions from './AgentCardChatActions.svelte'
  import AgentQuestionInstructionModal from './AgentQuestionInstructionModal.svelte'
  import { fitQuestionCard } from './question-card-fit'

  interface Props {
    request: PendingAgentQuestionRequest
    onAnswer: (requestId: string, answers: string[][]) => Promise<void>
    onDismiss: (requestId: string) => Promise<void>
    /** Persists draft progress; resolves to `null` when the request already settled. */
    onUpdate: (
      requestId: string,
      questionIndex: number,
      answers: string[],
      nextQuestionIndex?: number
    ) => Promise<PendingAgentQuestionRequest | null>
    scope: SpeechScope
    /** Open the explain side chat for the given question, pausing its timeout. */
    onExplain?: (requestId: string, question: AgentQuestion) => void
    /** Open a quick chat for the given question, pausing its timeout. */
    onQuickChat?: (requestId: string, question: AgentQuestion) => void
    settings?: ThreadSettings
    providers?: ProviderCatalog[]
    projectId?: string | null
    favoriteModels?: string[]
    recentModels?: string[]
    onModelChange?: (settings: ThreadSettings) => void
    onToggleFavorite?: (providerId: string, modelId: string, harnessId: string) => void
    /** Removes one model from the recently-used history; shows the "x" on recent rows. */
    onRemoveRecent?: (modelKey: string) => void
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
  }

  let {
    request,
    onAnswer,
    onDismiss,
    onUpdate,
    scope,
    onExplain,
    onQuickChat,
    settings,
    providers = [],
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite
  }: Props = $props()

  // The parent keys this component by request id, so these drafts belong to one
  // authoritative pending request for the lifetime of the component.
  // svelte-ignore state_referenced_locally
  let currentIndex = $state(request.activeQuestionIndex)
  // svelte-ignore state_referenced_locally
  let answers = $state<string[][]>(
    request.questions.map((_, index) => [...(request.answers[index] ?? [])])
  )
  // svelte-ignore state_referenced_locally
  let customAnswers = $state<string[]>(
    request.questions.map((question, index) => {
      const persisted = request.answers[index]?.[0]
      return persisted && !isOptionAnswer(question, persisted) ? persisted : ''
    })
  )
  let working = $state(false)
  let actionError = $state('')
  let folded = $state(false)
  /** The option whose instruction the user opened for copying, or null. */
  let instructionOption = $state<AgentQuestionOption | null>(null)
  // svelte-ignore state_referenced_locally
  let interactedIndexes = new SvelteSet(request.interactedQuestionIndexes)
  let syncedServerState = $state('')
  let customSaveTimer: ReturnType<typeof setTimeout> | undefined
  let customAnswerEditor = $state<RichMarkdownEditor>()
  /** The scrollable body every question shares, so a step moves the card's own
   *  content instead of swapping it out, and the scroll can return to the top. */
  let entryBody = $state<HTMLElement | undefined>(undefined)
  const customAnswerSpeechTargetId = $derived(`custom-answer-${request.requestId}-${currentIndex}`)

  function isOptionAnswer(question: AgentQuestion, value: string): boolean {
    return (
      (question.options?.includes(value) ?? false) ||
      (question.richOptions?.some((option) => option.label === value) ?? false)
    )
  }

  let question = $derived(request.questions[currentIndex])
  let total = $derived(request.questions.length)
  let currentAnswers = $derived(answers[currentIndex] ?? [])
  let currentCustomAnswer = $derived(customAnswers[currentIndex] ?? '')
  let allAnswered = $derived(answers.every((answer) => answer.length > 0))
  // The send key resolved through the user's keymap overrides, so the stepper's
  // forward arrow advertises whichever combination advances the walkthrough.
  let advanceShortcutLabel = $derived(formatKeyCombo(keymapState.keysFor('chat-send')))
  // The close in the head ends the whole request, and the title says so: a bare
  // X on a card that walks through several questions reads as "skip this one".
  let dismissTitle = $derived(total > 1 ? 'Dismiss all questions' : 'Dismiss this question')
  // Paused is read from the server's own deadline, never from local interaction:
  // the main process holds the countdown while the user is active anywhere in the
  // app and only hands back a fresh window once they stop. Saying "Paused" off a
  // local set is what let the card look frozen while it was still counting down.
  let timerPaused = $derived(request.expiresAt === undefined)
  // Time is an external system, so the countdown subscribes to it instead of
  // tracking it in an effect; the interval only runs while the timer is live.
  const subscribeToClock = createSubscriber((update) => {
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  })
  let remainingMs = $derived.by(() => {
    if (timerPaused || request.expiresAt === undefined) return null
    subscribeToClock()
    return Math.max(0, request.expiresAt - Date.now())
  })
  let remainingLabel = $derived(remainingMs === null ? 'Paused' : formatRemaining(remainingMs))
  // The chip only claims urgency while the clock is actually running and the
  // window is nearly gone; a paused timer is a state, not a warning.
  let timerTone = $derived<'default' | 'paused' | 'urgent'>(
    timerPaused ? 'paused' : remainingMs !== null && remainingMs <= 60_000 ? 'urgent' : 'default'
  )
  let timerTitle = $derived(
    timerPaused
      ? 'The countdown is paused while you fill this card in'
      : 'The recommended answer is selected automatically when time expires'
  )

  // Plain-markdown rendition of the question and its options that the agent
  // speaks aloud via the speaker button; keyed to the visible question.
  const speechMessageId = $derived(`agent-question-${request.requestId}-${currentIndex}`)
  let spokenQuestionText = $derived.by(() => {
    const parts: string[] = []
    if (question.header) parts.push(question.header)
    parts.push(question.prompt)
    if (question.description) parts.push(question.description)
    if (question.richOptions && question.richOptions.length > 0) {
      parts.push(
        `Options:\n${question.richOptions
          .map((option) => {
            const suffix = option.recommended ? ' (recommended)' : ''
            return option.description
              ? `- ${option.label}${suffix}: ${option.description}`
              : `- ${option.label}${suffix}`
          })
          .join('\n')}`
      )
    } else if (question.options && question.options.length > 0) {
      parts.push(`Options:\n${question.options.map((option) => `- ${option}`).join('\n')}`)
    }
    return parts.join('\n\n')
  })

  function customAnswerSpeechTarget() {
    return customAnswerEditor?.speechEditorTarget(customAnswerSpeechTargetId) ?? null
  }

  $effect(() => {
    const serverAnswers = request.answers
    const serverIndex = request.activeQuestionIndex
    const serverInteracted = request.interactedQuestionIndexes
    const serverState = JSON.stringify([serverIndex, serverAnswers, serverInteracted])
    if (serverState === syncedServerState) return
    syncedServerState = serverState
    answers = answers.map((answer, index) =>
      answer.length > 0 ? answer : [...(serverAnswers[index] ?? [])]
    )
    customAnswers = customAnswers.map((customAnswer, index) => {
      if (customAnswer) return customAnswer
      const persisted = serverAnswers[index]?.[0]
      if (!persisted) return customAnswer
      const question = request.questions[index]
      return isOptionAnswer(question, persisted) ? customAnswer : persisted
    })
    showEntry(serverIndex)
    for (const index of serverInteracted) interactedIndexes.add(index)
  })

  /**
   * Show another question. Every path that moves the index goes through here, so
   * the step motion is played once, in the direction the card actually moved,
   * and the next question is read from its first line rather than inheriting the
   * scroll position of the one before it.
   */
  function showEntry(index: number): void {
    if (index === currentIndex) return
    const direction: StepDirection = index > currentIndex ? 1 : -1
    if (entryBody) playEntryStep(entryBody, direction)
    currentIndex = index
    if (entryBody) entryBody.scrollTop = 0
  }

  function goPrev(): void {
    if (currentIndex > 0) navigateTo(currentIndex - 1)
  }

  function goNext(): void {
    if (currentIndex < total - 1) navigateTo(currentIndex + 1)
  }

  function setAnswer(index: number, value: string[]): void {
    answers = answers.map((answer, answerIndex) => (answerIndex === index ? value : answer))
  }

  function setCustomAnswer(value: string): void {
    customAnswers = customAnswers.map((answer, index) => (index === currentIndex ? value : answer))
    const trimmed = value.trim()
    setAnswer(currentIndex, trimmed ? [trimmed] : [])
  }

  function markInteracted(index: number): void {
    interactedIndexes.add(index)
  }

  function persistProgress(index: number, value: string[], nextQuestionIndex?: number): void {
    markInteracted(index)
    void onUpdate(request.requestId, index, [...value], nextQuestionIndex).catch((error) => {
      actionError = error instanceof Error ? error.message : 'Question progress could not be saved.'
    })
  }

  function navigateTo(index: number): void {
    if (working || index === currentIndex) return
    const previousIndex = currentIndex
    const previousAnswers = answers[previousIndex] ?? []
    showEntry(index)
    persistProgress(previousIndex, previousAnswers, index)
  }

  function toggleOption(option: string): void {
    if (working) return
    if (customSaveTimer !== undefined) {
      clearTimeout(customSaveTimer)
      customSaveTimer = undefined
    }
    customAnswers = customAnswers.map((answer, index) => (index === currentIndex ? '' : answer))
    const updated = question.multiple
      ? currentAnswers.includes(option)
        ? currentAnswers.filter((answer) => answer !== option)
        : [...currentAnswers, option]
      : [option]
    const answeredIndex = currentIndex
    const shouldAdvance = !question.multiple && answeredIndex < total - 1
    const nextIndex = shouldAdvance ? answeredIndex + 1 : undefined
    setAnswer(answeredIndex, updated)
    // Picking an option is the walkthrough advancing itself, so it is a step like
    // any other and moves the body rather than swapping the content under it.
    if (nextIndex !== undefined) showEntry(nextIndex)
    persistProgress(answeredIndex, updated, nextIndex)
  }

  /** Answers the user picked outside the predefined options (attached files). */
  let attachedAnswers = $derived(
    question.fileRequest
      ? currentAnswers.filter(
          (answer) =>
            !(question.options?.includes(answer) ?? false) &&
            !(question.richOptions?.some((option) => option.label === answer) ?? false)
        )
      : []
  )

  async function attachFiles(): Promise<void> {
    if (working) return
    try {
      const paths = await invoke('dialog:pickFiles')
      if (!paths.length) return
      const merged = [...currentAnswers]
      for (const path of paths) if (!merged.includes(path)) merged.push(path)
      markInteracted(currentIndex)
      setAnswer(currentIndex, merged)
      persistProgress(currentIndex, merged)
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The file could not be attached.'
    }
  }

  // Whole-card drop target for file-request questions. The card claims the
  // drop (and marks itself as a self-handled drop region, see
  // chat-composer-drop.ts) so the conversation composer never also attaches
  // the same files as message attachments.
  let draggingFiles = $state(false)

  function isFileDrag(e: DragEvent): boolean {
    return Array.from(e.dataTransfer?.types ?? []).includes('Files')
  }

  function handleCardDragOver(e: DragEvent): void {
    if (!question.fileRequest || working || !isFileDrag(e)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    draggingFiles = true
  }

  function handleCardDragLeave(e: DragEvent): void {
    if (!question.fileRequest) return
    const card = e.currentTarget
    if (
      card instanceof HTMLElement &&
      e.relatedTarget instanceof Node &&
      card.contains(e.relatedTarget)
    ) {
      return
    }
    draggingFiles = false
  }

  function handleCardDrop(e: DragEvent): void {
    draggingFiles = false
    if (!question.fileRequest || working) return
    const files = e.dataTransfer?.files
    if (!files || files.length === 0) return
    e.preventDefault()
    e.stopPropagation()
    const paths: string[] = []
    for (const file of Array.from(files)) {
      const path = window.api.getPathForFile(file)
      if (path && !paths.includes(path)) paths.push(path)
    }
    if (paths.length === 0) return
    const merged = [...currentAnswers]
    for (const path of paths) if (!merged.includes(path)) merged.push(path)
    markInteracted(currentIndex)
    setAnswer(currentIndex, merged)
    persistProgress(currentIndex, merged)
  }

  function removeAttachedAnswer(path: string): void {
    if (working) return
    const updated = currentAnswers.filter((answer) => answer !== path)
    markInteracted(currentIndex)
    setAnswer(currentIndex, updated)
    persistProgress(currentIndex, updated)
  }

  function handleCustomInput(value: string): void {
    setCustomAnswer(value)
    const index = currentIndex
    if (!interactedIndexes.has(index)) markInteracted(index)
    if (customSaveTimer !== undefined) clearTimeout(customSaveTimer)
    customSaveTimer = setTimeout(() => {
      customSaveTimer = undefined
      const trimmed = value.trim()
      persistProgress(index, trimmed ? [trimmed] : [])
    }, 500)
  }

  onDestroy(() => {
    if (customSaveTimer !== undefined) {
      clearTimeout(customSaveTimer)
      const index = currentIndex
      const trimmed = (customAnswers[index] ?? '').trim()
      if (trimmed) {
        void onUpdate(request.requestId, index, [trimmed]).catch(() => {
          // Best-effort flush; the request may already be resolving.
        })
      }
    }
  })

  /**
   * The custom answer editor's send shortcut (Cmd/Ctrl+Enter). While the
   * request still has a question after this one, the key advances to it so a
   * whole multi-question request can be answered from the keyboard; on the
   * last question it submits every answer, as it always did.
   */
  function handleEditorSubmit(): void {
    if (currentIndex < total - 1) {
      goNext()
      return
    }
    void handleSubmit()
  }

  async function handleSubmit(): Promise<void> {
    if (!allAnswered || working) return
    working = true
    actionError = ''
    try {
      await onAnswer(
        request.requestId,
        answers.map((answer) => [...answer])
      )
    } catch (error) {
      working = false
      actionError = error instanceof Error ? error.message : 'The answer could not be sent.'
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
      actionError = error instanceof Error ? error.message : 'The question could not be discarded.'
    }
  }

  /** Opens the copyable instruction modal for one option. */
  function openInstruction(option: AgentQuestionOption): void {
    if (working) return
    instructionOption = option
  }

  function openQuestionChat(
    onOpen: ((requestId: string, question: AgentQuestion) => void) | undefined
  ): void {
    if (working || !onOpen) return
    // Persisting progress without a next index clears the timeout, so the timer
    // is paused while the user works in the temporary chat.
    persistProgress(currentIndex, currentAnswers)
    onOpen(request.requestId, question)
  }
</script>

<section
  out:slide={dismissSlide()}
  data-drop-region={question.fileRequest ? 'file-request-card' : undefined}
  class={cardFrameClass(
    'replace',
    `question-card relative overflow-hidden ${draggingFiles ? 'border-primary' : ''}`
  )}
  aria-label="Agent question"
  ondragover={handleCardDragOver}
  ondragleave={handleCardDragLeave}
  ondrop={handleCardDrop}
  {@attach fitQuestionCard}
>
  {#if draggingFiles}
    <div
      class="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/5"
    >
      <p class="bg-surface px-3 py-1.5 text-xs font-medium text-primary shadow-sm">
        Drop files to attach
      </p>
    </div>
  {/if}

  <!-- The card that takes the composer's place while the agent waits for an
     answer: the question's own header, the choices, and the two actions that end
     it. The countdown chip is the card's real reading, and it turns urgent only
     while the clock is running. -->
  <CardHead
    icon={TriangleQuestionMark}
    title={question.header ?? 'Question'}
    chip={{
      text: remainingLabel,
      tone: timerTone,
      title: timerTitle,
      label: timerPaused ? 'The countdown is paused' : `Time remaining: ${remainingLabel}`
    }}
    foldLabel="question"
    bind:folded
  >
    {#snippet actions()}
      <AgentCardChatActions
        onExplain={onExplain ? () => openQuestionChat(onExplain) : undefined}
        onQuickChat={onQuickChat ? () => openQuestionChat(onQuickChat) : undefined}
        subject="question"
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
    <div class="flex min-h-0 flex-1 flex-col" transition:slide={foldSlide()}>
      <!-- The scrollable half: the question, its options and the custom answer
         give way first, while the header above and the footer below stay put.
         Every question renders into this one body, so a step moves the body's
         content (see `showEntry`) instead of the body animating in again. -->
      <div
        bind:this={entryBody}
        class="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-4"
      >
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

        {#if question.richOptions && question.richOptions.length > 0}
          <div class="grid gap-2" role="group" aria-label="Answer options">
            {#each question.richOptions as option (option.label)}
              {@const selected = currentAnswers.includes(option.label) && !currentCustomAnswer}
              <!-- The option is a split control: selecting it is one button, and an
                   instruction it carries gets its own button so the copyable text
                   never sits inside the selection target. -->
              <CardOption
                title={option.label}
                description={option.description}
                {selected}
                disabled={working}
                multiple={question.multiple === true}
                mono={question.fileRequest === true}
                badge={option.recommended ? { text: 'Recommended', tone: 'ok' } : undefined}
                onclick={() => toggleOption(option.label)}
              >
                {#snippet trailing()}
                  {#if option.instruction}
                    <button
                      type="button"
                      class="flex w-10 shrink-0 items-center justify-center border-l border-border text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                      disabled={working}
                      onclick={() => openInstruction(option)}
                      title={`View instruction: ${option.label}`}
                      aria-label={`View instruction for ${option.label}`}
                    >
                      <CioClipboardList size={14} />
                    </button>
                  {/if}
                {/snippet}
              </CardOption>
            {/each}
          </div>
        {:else if question.options && question.options.length > 0}
          <div class="grid gap-2 sm:grid-cols-2" role="group" aria-label="Answer options">
            {#each question.options as option (option)}
              {@const selected = currentAnswers.includes(option) && !currentCustomAnswer}
              <CardOption
                title={option}
                {selected}
                disabled={working}
                onclick={() => toggleOption(option)}
              />
            {/each}
          </div>
        {/if}

        {#if question.fileRequest}
          <div class="space-y-2">
            {#if attachedAnswers.length > 0}
              <div class="flex flex-wrap gap-1.5" role="list" aria-label="Attached files">
                {#each attachedAnswers as attachedPath (attachedPath)}
                  <span
                    class="flex max-w-full min-w-0 items-center gap-1 border border-border bg-elevated px-2 py-1"
                    role="listitem"
                  >
                    <CioPaperclip size={11} class="shrink-0 text-muted" aria-hidden="true" />
                    <span class="truncate font-mono text-[0.6875rem] text-foreground"
                      >{attachedPath}</span
                    >
                    <button
                      type="button"
                      class="flex h-4 w-4 shrink-0 items-center justify-center text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                      disabled={working}
                      onclick={() => removeAttachedAnswer(attachedPath)}
                      title="Remove this attached file"
                      aria-label={`Remove attached file ${attachedPath}`}
                    >
                      <CioClose size={11} />
                    </button>
                  </span>
                {/each}
              </div>
            {/if}
            <CardButton
              label="Attach files…"
              title="Attach files from your computer to share with the agent"
              icon={CioPaperclip}
              variant="secondary"
              disabled={working}
              onclick={() => void attachFiles()}
            />
          </div>
        {/if}

        {#if question.custom !== false}
          <div>
            <label
              class="mb-1.5 block text-xs font-medium text-muted"
              for={`custom-answer-${request.requestId}-${currentIndex}`}
            >
              {question.options?.length || question.richOptions?.length
                ? question.fileRequest
                  ? 'Or type a file path'
                  : 'Or write your own response'
                : 'Your response'}
            </label>
            <div class="flex items-stretch gap-2">
              <RichMarkdownEditor
                bind:this={customAnswerEditor}
                id={`custom-answer-${request.requestId}-${currentIndex}`}
                value={currentCustomAnswer}
                class="max-h-40 min-h-10 w-full resize-none overflow-y-auto border bg-elevated px-3 py-2 text-sm text-foreground outline-none transition-[width] focus:border-primary disabled:opacity-50"
                containerClass="min-w-0 flex-1"
                placeholder="Type your response…"
                ariaLabel="Your response"
                disabled={working}
                onValueChange={handleCustomInput}
                onSubmit={handleEditorSubmit}
              />
              <div class="flex shrink-0 items-center">
                <VoiceInputButton
                  targetId={customAnswerSpeechTargetId}
                  getTarget={customAnswerSpeechTarget}
                  {scope}
                  disabled={working}
                />
              </div>
            </div>
          </div>
        {/if}

        {#if actionError}
          <p
            class="bg-danger/10 px-3 py-2 text-xs text-danger"
            role="alert"
            transition:fly={rowArrive()}
          >
            {actionError}
          </p>
        {/if}
      </div>

      <!-- Shrinkable footer: the row never lets one control paint over another.
         Stepping through the questions and reading them aloud sit on the falsy
         side, the model switch and the submit that ends the card on the truthy
         side. The context actions live in the head, so the row stays short. -->
      <CardFoot>
        {#snippet left()}
          <CardStepper
            subject="question"
            index={currentIndex}
            {total}
            advanceHint={advanceShortcutLabel}
            disabled={working}
            onPrev={goPrev}
            onNext={goNext}
          />
          {#if !allAnswered}
            <p class="min-w-0 truncate text-[0.6875rem] text-muted" transition:fly={rowArrive()}>
              {total > 1 ? 'Answer every question to send' : 'Answer this question to send'}
            </p>
          {/if}
          <!-- Self-hides when no TTS artifact is installed -->
          <QuestionSpeechControls
            messageId={speechMessageId}
            markdown={spokenQuestionText}
            disabled={working}
          />
        {/snippet}
        {#snippet right()}
          <EngineeringModelSwitch
            {settings}
            {providers}
            {projectId}
            {favoriteModels}
            {recentModels}
            {onRemoveRecent}
            {onModelChange}
            {onToggleFavorite}
            {onReorderFavorite}
          />
          <CardButton
            label={working ? 'Sending…' : `Submit ${total > 1 ? 'answers' : 'answer'}`}
            title="Send your answer to the agent"
            icon={CioSend}
            variant="primary"
            loading={working}
            disabled={!allAnswered || working}
            onclick={() => void handleSubmit()}
          />
        {/snippet}
      </CardFoot>
    </div>
  {/if}

  <AgentQuestionInstructionModal
    open={instructionOption !== null}
    optionLabel={instructionOption?.label ?? ''}
    instruction={instructionOption?.instruction ?? ''}
    onClose={() => (instructionOption = null)}
  />
</section>

<style>
  /*
    The card never grows past the room its conversation pane offers, which
    `question-card-fit` measures and writes here; the viewport clamp is the
    fallback for the first frame and for a host that renders no pane. The body
    scrolls inside this ceiling, so a long option list stays reachable and the
    header and footer stay pinned.
  */
  :global(.question-card) {
    max-height: var(--question-card-max-height, calc(100dvh - 6rem));
  }
</style>
