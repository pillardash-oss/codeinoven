<script lang="ts">
  import {
    ChevronLeft,
    ChevronRight,
    Clock,
    CornerDownRight,
    Eye,
    EyeOff,
    KeyRound,
    Loader2,
    ShieldCheck,
    X
  } from '@lucide/svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import { slide } from 'svelte/transition'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import CardFoldToggle from '../shared/CardFoldToggle.svelte'
  import { dismissSlide, foldSlide } from '../shared/card-motion'
  import { formatRemaining } from '../shared/card-timer'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import type { SpeechScope } from '../../../../lib/speech/types'
  import type { AgentSecretSubmission, PendingAgentQuestionRequest } from '$shared/types'

  interface Props {
    request: PendingAgentQuestionRequest
    /** Sends the pasted values to the main process; they never enter the transcript. */
    onSubmit: (requestId: string, secrets: AgentSecretSubmission[]) => Promise<void>
    /**
     * Sends an instruction instead of a value: the main process reuses whatever
     * the device already holds for the requested names and hands the instruction
     * to the agent, so a value the user cannot reach any more is never re-asked.
     */
    onAlternative: (requestId: string, alternative: string) => Promise<void>
    onDismiss: (requestId: string) => Promise<void>
    scope: SpeechScope
  }

  let { request, onSubmit, onAlternative, onDismiss, scope }: Props = $props()

  // The parent keys this component by request id, so these drafts belong to one
  // authoritative pending request for the lifetime of the component.
  let currentIndex = $state(0)
  // svelte-ignore state_referenced_locally
  let values = $state<string[]>(request.questions.map(() => ''))
  let revealedIndex = $state<number | null>(null)
  let working = $state(false)
  let actionError = $state('')
  let folded = $state(false)
  let showingAlternative = $state(false)
  let alternative = $state('')
  let alternativeEditor = $state<RichMarkdownEditor>()

  let total = $derived(request.questions.length)
  let question = $derived(request.questions[currentIndex])
  let currentValue = $derived(values[currentIndex] ?? '')
  let currentRevealed = $derived(revealedIndex === currentIndex)
  let filledCount = $derived(values.filter((value) => value.trim().length > 0).length)
  let allFilled = $derived(filledCount === total)
  let canSubmitAlternative = $derived(alternative.trim().length > 0 && !working)
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
  let remainingLabel = $derived(remainingMs === null ? 'No deadline' : formatRemaining(remainingMs))
  /** Every variable this request asks for, so reuse is stated before it happens. */
  let requestedVariables = $derived(
    request.questions.flatMap((entry) =>
      entry.secretEnvironmentVariable ? [entry.secretEnvironmentVariable] : []
    )
  )
  const alternativeTargetId = $derived(`secret-alternative-${request.requestId}`)

  function alternativeSpeechTarget() {
    return alternativeEditor?.speechEditorTarget(alternativeTargetId) ?? null
  }

  function showAlternative(): void {
    showingAlternative = true
  }

  function cancelAlternative(): void {
    showingAlternative = false
    alternative = ''
  }

  async function handleAlternative(): Promise<void> {
    const instruction = alternative.trim()
    if (!instruction || working) return
    working = true
    actionError = ''
    try {
      await onAlternative(request.requestId, instruction)
    } catch (error) {
      working = false
      actionError =
        error instanceof Error ? error.message : 'The alternative instruction could not be sent.'
    }
  }

  function toggleReveal(): void {
    revealedIndex = currentRevealed ? null : currentIndex
  }

  function goPrev(): void {
    if (currentIndex > 0) currentIndex -= 1
  }

  function goNext(): void {
    if (currentIndex < total - 1) currentIndex += 1
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
      secrets.push({ secretId, value: (values[index] ?? '').trim() })
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
  class="overflow-hidden rounded-xl border bg-surface shadow-sm"
  aria-label="Agent secret request"
>
  <div class="flex items-center justify-between gap-3 border-b px-4 py-2.5">
    <div class="min-w-0">
      <p class="truncate text-xs font-semibold uppercase tracking-wide text-muted">
        {question.header ?? 'Secret'}
      </p>
      {#if total > 1}
        <p class="mt-0.5 text-xs tabular-nums text-dimmed">
          Secret {currentIndex + 1} of {total}
        </p>
      {/if}
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <span
        class="mr-1 flex items-center gap-1 text-[0.6875rem] tabular-nums text-muted"
        aria-label={`Time remaining: ${remainingLabel}`}
        title="The card closes when the time runs out; ask the agent again for a new one"
      >
        <Clock size={12} />
        {remainingLabel}
      </span>
      {#if total > 1}
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          disabled={currentIndex === 0 || working}
          onclick={goPrev}
          title="Previous secret"
          aria-label="Previous secret"
        >
          <ChevronLeft size={15} />
        </button>
        <button
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
          disabled={currentIndex === total - 1 || working}
          onclick={goNext}
          title="Next secret"
          aria-label="Next secret"
        >
          <ChevronRight size={15} />
        </button>
      {/if}
      <button
        class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-30"
        disabled={working}
        onclick={() => void handleDismiss()}
        title="Discard this secret request"
        aria-label="Discard this secret request"
      >
        <X size={15} />
      </button>
      <CardFoldToggle bind:folded label="secret request" />
    </div>
  </div>

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

        {#if showingAlternative}
          <div class="space-y-1.5">
            <label class="block text-xs font-medium text-muted" for={alternativeTargetId}>
              Alternative instruction
            </label>
            <div class="flex items-start gap-2">
              <RichMarkdownEditor
                bind:this={alternativeEditor}
                id={alternativeTargetId}
                bind:value={alternative}
                autofocus
                disabled={working}
                placeholder="Say what the agent should use instead, or name the variable you already provided…"
                class="w-full resize-y rounded-lg border bg-elevated px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-dimmed focus:border-primary disabled:opacity-50"
                containerClass="min-w-0 flex-1"
                ariaLabel="Alternative instruction"
                onSubmit={() => void handleAlternative()}
              />
              <VoiceInputButton
                targetId={alternativeTargetId}
                getTarget={alternativeSpeechTarget}
                {scope}
                disabled={working}
              />
            </div>
            <p class="text-xs text-dimmed">
              No value is stored from this card. Whatever the device already holds for
              {#if requestedVariables.length > 0}
                <span class="font-mono text-foreground">{requestedVariables.join(', ')}</span>
              {:else}
                this request
              {/if}
              is reused from your encrypted vault and handed to the agent, and your instruction reaches
              it as written.
            </p>
          </div>
        {:else}
          {#key currentIndex}
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
                  class="h-10 w-full rounded-lg border bg-elevated pr-10 pl-9 font-mono text-sm text-foreground outline-none transition-colors focus:border-primary disabled:opacity-50"
                  type={currentRevealed ? 'text' : 'password'}
                  autocomplete="off"
                  autocapitalize="off"
                  autocorrect="off"
                  spellcheck="false"
                  disabled={working}
                  placeholder="Paste the value"
                  bind:value={values[currentIndex]}
                />
                <button
                  class="absolute top-1/2 right-1.5 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface hover:text-foreground disabled:opacity-40"
                  type="button"
                  disabled={working}
                  aria-pressed={currentRevealed}
                  title={currentRevealed ? 'Hide the value' : 'Show the value'}
                  aria-label={currentRevealed ? 'Hide the value' : 'Show the value'}
                  onclick={toggleReveal}
                >
                  {#if currentRevealed}
                    <EyeOff size={14} />
                  {:else}
                    <Eye size={14} />
                  {/if}
                </button>
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
          {/key}
        {/if}

        {#if actionError}
          <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {actionError}
          </p>
        {/if}
      </div>
    </div>
  {/if}

  <div class="flex min-w-0 items-center justify-between gap-3 border-t px-4 py-2.5">
    <p class="flex min-w-0 items-center gap-1.5 text-xs text-muted">
      <ShieldCheck size={13} class="shrink-0 text-primary" />
      <span class="min-w-0 truncate">Secrets are not sent to the agent</span>
    </p>
    <div class="flex min-w-0 shrink items-center justify-end gap-2">
      {#if showingAlternative}
        <button
          class="min-h-8 shrink-0 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
          disabled={working}
          onclick={cancelAlternative}
        >
          Cancel
        </button>
        <button
          class="flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={!canSubmitAlternative}
          onclick={() => void handleAlternative()}
        >
          Send alternative
          <CornerDownRight size={13} />
        </button>
      {:else}
        {#if total > 1}
          <span class="shrink-0 text-xs tabular-nums text-dimmed">{filledCount} of {total}</span>
        {/if}
        <button
          class="min-h-8 shrink-0 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-overlay disabled:opacity-40"
          disabled={working}
          onclick={showAlternative}
        >
          Provide alternative
        </button>
        {#if currentIndex < total - 1}
          <button
            class="flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={working || !currentValue.trim()}
            onclick={goNext}
          >
            Next
            <ChevronRight size={13} />
          </button>
        {:else}
          <button
            class="flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={working || !allFilled}
            onclick={() => void handleSubmit()}
          >
            {#if working}
              <Loader2 size={13} class="animate-spin" />
              Storing…
            {:else}
              <ShieldCheck size={13} />
              Submit
            {/if}
          </button>
        {/if}
      {/if}
    </div>
  </div>
</section>
