<script lang="ts">
  import {
    Check,
    ChevronLeft,
    ChevronRight,
    Clock,
    HelpCircle,
    MessageSquareDashed,
    Paperclip,
    Send,
    X
  } from '@lucide/svelte'
  import { onDestroy } from 'svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import { invoke } from '$lib/ipc.svelte'
  import { blockHtml, lexMarkdown } from '../markdown/markdown'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import QuestionSpeechControls from '../speech/QuestionSpeechControls.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type {
    AgentQuestion,
    PendingAgentQuestionRequest,
    ProviderCatalog,
    ThreadSettings
  } from '$shared/types'
  import EngineeringModelSwitch from '../shared/EngineeringModelSwitch.svelte'

  interface Props {
    request: PendingAgentQuestionRequest
    onAnswer: (requestId: string, answers: string[][]) => Promise<void>
    onDismiss: (requestId: string) => Promise<void>
    onUpdate: (
      requestId: string,
      questionIndex: number,
      answers: string[],
      nextQuestionIndex?: number
    ) => Promise<PendingAgentQuestionRequest>
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
  let now = $state(Date.now())
  // svelte-ignore state_referenced_locally
  let interactedIndexes = new SvelteSet(request.interactedQuestionIndexes)
  let syncedServerState = $state('')
  let customSaveTimer: ReturnType<typeof setTimeout> | undefined
  let customAnswerEditor = $state<RichMarkdownEditor>()
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
  let timerPaused = $derived(interactedIndexes.has(currentIndex) || request.expiresAt === undefined)
  let remainingMs = $derived(
    timerPaused || request.expiresAt === undefined ? null : Math.max(0, request.expiresAt - now)
  )
  let remainingLabel = $derived(remainingMs === null ? 'Paused' : formatRemaining(remainingMs))

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
    if (request.expiresAt === undefined) return
    const timer = window.setInterval(() => {
      now = Date.now()
    }, 1_000)
    return () => window.clearInterval(timer)
  })

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
    currentIndex = serverIndex
    for (const index of serverInteracted) interactedIndexes.add(index)
  })

  function formatRemaining(milliseconds: number): string {
    const seconds = Math.ceil(milliseconds / 1_000)
    const minutes = Math.floor(seconds / 60)
    const remainder = seconds % 60
    return minutes > 0 ? `${minutes}:${String(remainder).padStart(2, '0')}` : `${seconds}s`
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
    currentIndex = index
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
    if (nextIndex !== undefined) currentIndex = nextIndex
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

<section class="overflow-hidden rounded-xl border bg-surface shadow-sm" aria-label="Agent question">
  <div class="flex items-center justify-between gap-3 border-b px-4 py-2.5">
    <div class="min-w-0">
      <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">
        {question.header ?? 'Question'}
      </p>
      {#if total > 1}
        <p class="mt-0.5 text-[11px] tabular-nums text-dimmed">
          Question {currentIndex + 1} of {total}
        </p>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <span
        class="mr-1 flex items-center gap-1 text-[11px] tabular-nums text-muted"
        aria-label={`Time remaining: ${remainingLabel}`}
        title="The recommended answer is selected automatically when time expires"
      >
        <Clock size={12} />
        {remainingLabel}
      </span>
      {#if total > 1}
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          disabled={currentIndex === 0 || working}
          onclick={goPrev}
          aria-label="Previous question"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          disabled={currentIndex === total - 1 || working}
          onclick={goNext}
          aria-label="Next question"
        >
          <ChevronRight size={15} />
        </button>
      {/if}
      <button
        class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30"
        disabled={working}
        onclick={() => void handleDismiss()}
        aria-label="Discard question request"
        title="Discard this question request"
      >
        <X size={15} />
      </button>
    </div>
  </div>

  <div class="space-y-3 p-4">
    <div class="space-y-1">
      <div class="text-sm text-foreground">
        {#each lexMarkdown(question.prompt) as token (token.raw)}
          {#if token.type !== 'space'}
            <!-- eslint-disable-next-line svelte/no-at-html-tags -- blockHtml is DOMPurify-sanitized -->
            {@html blockHtml(token)}
          {/if}
        {/each}
      </div>
      {#if question.description}
        <div class="text-xs text-muted">
          {#each lexMarkdown(question.description) as token (token.raw)}
            {#if token.type !== 'space'}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -- blockHtml is DOMPurify-sanitized -->
              {@html blockHtml(token)}
            {/if}
          {/each}
        </div>
      {/if}
    </div>

    {#if question.richOptions && question.richOptions.length > 0}
      <div class="grid gap-2" role="group" aria-label="Answer options">
        {#each question.richOptions as option (option.label)}
          {@const selected = currentAnswers.includes(option.label) && !currentCustomAnswer}
          <button
            class={[
              'flex min-h-12 w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'border-primary bg-primary text-on-primary'
                : 'border-border bg-surface text-foreground hover:bg-elevated'
            ]}
            disabled={working}
            aria-pressed={selected}
            onclick={() => toggleOption(option.label)}
          >
            <span
              class={[
                'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border text-[9px]',
                question.multiple ? 'rounded' : 'rounded-full',
                selected ? 'border-on-primary bg-on-primary text-primary' : 'border-muted'
              ]}
            >
              {#if selected}<Check size={11} />{/if}
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
                {#if question.fileRequest}
                  <span class="break-all font-mono text-[11px] font-medium">{option.label}</span>
                {:else}
                  {option.label}
                {/if}
                {#if option.recommended}
                  <span
                    class={[
                      'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                      selected ? 'bg-on-primary/15 text-on-primary' : 'bg-primary/10 text-primary'
                    ]}
                  >
                    Recommended
                  </span>
                {/if}
              </span>
              {#if option.description}
                <span
                  class={[
                    'mt-0.5 block text-[11px] leading-relaxed',
                    selected ? 'text-on-primary/80' : 'text-muted'
                  ]}
                >
                  {option.description}
                </span>
              {/if}
            </span>
          </button>
        {/each}
      </div>
    {:else if question.options && question.options.length > 0}
      <div class="flex flex-wrap gap-2" role="group" aria-label="Answer options">
        {#each question.options as option (option)}
          {@const selected = currentAnswers.includes(option) && !currentCustomAnswer}
          <button
            class={[
              'rounded-lg border px-3 py-2 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              selected
                ? 'border-primary bg-primary text-on-primary'
                : 'border-border bg-surface text-foreground hover:bg-elevated'
            ]}
            disabled={working}
            aria-pressed={selected}
            onclick={() => toggleOption(option)}
          >
            {#if selected}<Check size={12} class="mr-1 inline" />{/if}
            {option}
          </button>
        {/each}
      </div>
    {/if}

    {#if question.fileRequest}
      <div class="space-y-2">
        {#if attachedAnswers.length > 0}
          <div class="flex flex-wrap gap-1.5" role="list" aria-label="Attached files">
            {#each attachedAnswers as attachedPath (attachedPath)}
              <span
                class="flex max-w-full min-w-0 items-center gap-1 rounded-lg border border-border bg-elevated px-2 py-1"
                role="listitem"
              >
                <Paperclip size={11} class="shrink-0 text-muted" aria-hidden="true" />
                <span class="truncate font-mono text-[11px] text-foreground">{attachedPath}</span>
                <button
                  type="button"
                  class="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                  disabled={working}
                  onclick={() => removeAttachedAnswer(attachedPath)}
                  title="Remove this attached file"
                  aria-label={`Remove attached file ${attachedPath}`}
                >
                  <X size={11} />
                </button>
              </span>
            {/each}
          </div>
        {/if}
        <button
          type="button"
          class="flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          disabled={working}
          onclick={() => void attachFiles()}
          title="Attach files from your computer to share with the agent"
          aria-label="Attach files to share with the agent"
        >
          <Paperclip size={13} />
          Attach files…
        </button>
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
            class="max-h-40 min-h-10 w-full resize-none overflow-y-auto rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground outline-none transition-[width] focus:border-primary disabled:opacity-50"
            containerClass="min-w-0 flex-1"
            placeholder="Type your response…"
            ariaLabel="Your response"
            disabled={working}
            onValueChange={handleCustomInput}
            onSubmit={() => void handleSubmit()}
          />
          <div class="flex shrink-0 items-center">
            <VoiceInputButton
              targetId={customAnswerSpeechTargetId}
              getTarget={customAnswerSpeechTarget}
              {scope}
              disabled={working}
            />
          </div>
          {#if currentCustomAnswer.trim() && currentIndex < total - 1}
            <button
              type="button"
              class="flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={working}
              onclick={goNext}
            >
              Next
              <ChevronRight size={14} />
            </button>
          {/if}
        </div>
      </div>
    {/if}

    {#if actionError}
      <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {actionError}
      </p>
    {/if}
  </div>

  <div class="flex items-center justify-between gap-3 border-t px-4 py-2.5">
    <div class="flex min-w-0 items-center gap-2">
      {#if onExplain || onQuickChat}
        <div class="flex shrink-0 items-center gap-1">
          {#if onExplain}
            <button
              type="button"
              class="flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[11px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={working}
              onclick={() => openQuestionChat(onExplain)}
              title="Explain this question to help you decide"
              aria-label="Explain this question in a temporary read-only chat"
            >
              <HelpCircle size={13} />
              Explain
            </button>
          {/if}
          {#if onQuickChat}
            <button
              type="button"
              class="flex h-7 items-center gap-1 rounded-lg border border-border px-2 text-[11px] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              disabled={working}
              onclick={() => openQuestionChat(onQuickChat)}
              title="Start a temporary read-only quick chat about this question"
              aria-label="Start a temporary read-only quick chat about this question"
            >
              <MessageSquareDashed size={13} />
              Quick chat
            </button>
          {/if}
        </div>
      {:else}
        <p class="min-w-0 text-[11px] text-muted">
          {#if !currentAnswers.length}
            Answer this question to continue
          {:else if !allAnswered}
            {answers.filter((answer) => answer.length > 0).length} of {total} answered
          {:else}
            Ready to send
          {/if}
        </p>
      {/if}
      <!-- Self-hides when no TTS artifact is installed -->
      <QuestionSpeechControls
        messageId={speechMessageId}
        markdown={spokenQuestionText}
        disabled={working}
      />
    </div>
    <div class="flex shrink-0 items-center gap-2">
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
      <button
        class="flex min-h-8 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        disabled={!allAnswered || working}
        onclick={() => void handleSubmit()}
      >
      {#if working}
        Sending…
      {:else}
        <Send size={13} />
        Submit {total > 1 ? 'answers' : 'answer'}
      {/if}
      </button>
    </div>
  </div>
</section>
