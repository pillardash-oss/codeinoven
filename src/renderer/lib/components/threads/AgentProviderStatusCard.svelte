<script lang="ts">
  import CioAttention from '$lib/components/icons/cio/CioAttention.svelte'
  import CioCheck from '$lib/components/icons/cio/CioCheck.svelte'
  import CioClock from '$lib/components/icons/cio/CioClock.svelte'
  import CioClose from '$lib/components/icons/cio/CioClose.svelte'
  import CioCode from '$lib/components/icons/cio/CioCode.svelte'
  import CioCopy from '$lib/components/icons/cio/CioCopy.svelte'
  import CioLogIn from '$lib/components/icons/cio/CioLogIn.svelte'
  import CioSquare from '$lib/components/icons/cio/CioSquare.svelte'
  import CioTimerReset from '$lib/components/icons/cio/CioTimerReset.svelte'
  import CioUndo from '$lib/components/icons/cio/CioUndo.svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import { slide } from 'svelte/transition'
  import CardButton from '../shared/CardButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardFrame from '../shared/CardFrame.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import CardTag from '../shared/CardTag.svelte'
  import type { CardChipData } from '../shared/CardTimer.svelte'
  import { foldSlide } from '../shared/card-motion'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import type {
    AgentSessionStatus,
    ProviderCatalog,
    ThinkingLevel,
    ThreadSettings
  } from '$shared/types'
  import { copyText } from '$lib/copy-text'
  import { threadCardFold } from '$lib/stores/thread-card-fold.svelte'
  import { harnessAccountCache } from '$lib/stores/harness-accounts'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { normalizeFastInference, supportsFastInference } from '$shared/fast-inference'
  import { presentProviderError, providerIssueTitle } from '$shared/provider-issue'
  import { formatDateTimeWithWeekday } from '$shared/date-time-format'
  import Modal from '../ui/Modal.svelte'
  import ProviderSignInPanel from '../providers/ProviderSignInPanel.svelte'

  interface Props {
    status: Extract<AgentSessionStatus, { state: 'waiting' | 'error' }>
    providerName: string
    /** Current thread settings; required to render the shared model picker. */
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
    onStop?: () => void
    onRetry?: () => void | Promise<void>
    /** Called after a successful sign-in instead of the generic retry. */
    onSignedIn?: () => void
    onDismiss?: () => void
    sourceLabel?: string
    sourceDetail?: string
    retryLabel?: string
    retrying?: boolean
    /** Whether the app auto-resumes this thread once the reset time passes. */
    autoRetryEnabled?: boolean
    /** Another card sits directly above this one, so its top rule is the broken
     *  line that separates two stacked surfaces. */
    stackedAbove?: boolean
    /** The surface below carries the join, so this card drops its bottom rule. */
    joinsBelow?: boolean
    /** Thread the card reports on, so its fold state is remembered per thread. */
    threadId?: string
    /** Card key within the thread when one component serves more than one card
     *  (the thread's own provider status, and an attributed worker error). */
    foldKey?: string
  }

  let {
    status,
    providerName,
    settings,
    providers = [],
    projectId = null,
    favoriteModels = [],
    recentModels = [],
    onModelChange,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    onStop,
    onRetry,
    onSignedIn,
    onDismiss,
    sourceLabel,
    sourceDetail,
    retryLabel = 'Retry',
    retrying = false,
    autoRetryEnabled = true,
    stackedAbove = false,
    joinsBelow = false,
    threadId,
    foldKey = 'provider'
  }: Props = $props()
  /** The card's fold control writes a per-thread preference, so a card folded or
   *  unfolded by the reader stays that way when the thread is reopened. */
  let localFolded = $state(false)
  const foldState = {
    get folded(): boolean {
      return threadId === undefined ? localFolded : threadCardFold.isFolded(threadId, foldKey)
    },
    set folded(value: boolean) {
      if (threadId === undefined) localFolded = value
      else threadCardFold.setFolded(threadId, foldKey, value)
    }
  }
  let showRawError = $state(false)
  let copiedRawError = $state(false)
  let signInOpen = $state(false)
  /** Account the sign-in must write into, bound when the card opened the panel. */
  let signInAccountId = $state<string | undefined>(undefined)
  /** Provider the thread runs on, so the sign-in can be scoped to it. */
  let signInProviderId = $state<string | undefined>(undefined)
  const subscribeToClock = createSubscriber((update) => {
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  })
  const issue = $derived(status.issue)
  const now = $derived.by(() => {
    if (issue.retryAt !== undefined || issue.autoResumeAt !== undefined) subscribeToClock()
    return Date.now()
  })
  const resumeAt = $derived(issue.autoResumeAt)
  const queued = $derived(
    autoRetryEnabled && issue.autoResumeAt !== undefined && now >= issue.autoResumeAt
  )
  const rawError = $derived(issue.rawError?.trim() || issue.message.trim())
  /**
   * The card body is display copy, never diagnostic detail. A harness that
   * crashes inside its own runtime reports its exception text (stack trace
   * included) as an ordinary error string, so reduce whatever a driver handed
   * over to that trace's header line. Every provider card in the app renders
   * through this component, which makes it the one place that guarantees a
   * trace can never reach the body; the full text stays in `rawError` above,
   * which the Raw Error view shows.
   */
  const displayMessage = $derived(presentProviderError(issue.message).message)

  async function copyRawError(): Promise<void> {
    try {
      await copyText(rawError, null)
      copiedRawError = true
      setTimeout(() => (copiedRawError = false), 1500)
    } catch {
      // clipboard not available
    }
  }
  const waiting = $derived(status.state === 'waiting')
  /**
   * A usage/rate-limit reset that the app will (or can) auto-resume: a terminal
   * error on a harness that does not schedule its own retries, with a concrete
   * reset time. Rendered as a warning card with a countdown.
   */
  const autoResume = $derived(
    !waiting &&
      issue.retryAt !== undefined &&
      issue.harnessId !== 'opencode' &&
      (issue.kind === 'quota' ||
        issue.kind === 'rate_limit' ||
        issue.kind === 'provider_unavailable')
  )

  const URL_PATTERN = /https?:\/\/[^\s<>"']+/g

  function messageParts(message: string): Array<{ text: string; isLink: boolean }> {
    const parts: Array<{ text: string; isLink: boolean }> = []
    let lastIndex = 0
    for (const match of message.matchAll(URL_PATTERN)) {
      const start = match.index ?? 0
      if (start > lastIndex) {
        parts.push({ text: message.slice(lastIndex, start), isLink: false })
      }
      parts.push({ text: match[0], isLink: true })
      lastIndex = start + match[0].length
    }
    if (lastIndex < message.length) {
      parts.push({ text: message.slice(lastIndex), isLink: false })
    }
    return parts
  }

  /**
   * The card heading. Shared with every other surface that renders one of these
   * issues, so the same failure is never named two different things.
   */
  const title = $derived(providerIssueTitle(issue.kind, waiting))

  function relativeRetryTime(retryAt: number): string {
    const remainingSeconds = Math.max(0, Math.ceil((retryAt - now) / 1_000))
    if (remainingSeconds < 60) return `${remainingSeconds}s`
    const minutes = Math.floor(remainingSeconds / 60)
    if (minutes < 60) return `${minutes}m ${remainingSeconds % 60}s`
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
  }

  /**
   * The head's reading is the state the card is honestly in. A scheduled resume
   * shows the real deadline the card already computes; otherwise the state gets
   * its own word, urgent when it is a failure the user has to act on.
   */
  const chip = $derived.by<CardChipData>(() => {
    if (queued) return { text: 'Queued', tone: 'paused' }
    if (waiting) {
      return autoRetryEnabled && resumeAt !== undefined
        ? { text: `Retry in ${relativeRetryTime(resumeAt)}` }
        : { text: 'Waiting', tone: 'paused' }
    }
    if (issue.kind === 'authentication') return { text: 'Authentication', tone: 'urgent' }
    if (issue.kind === 'network') return { text: 'Network', tone: 'urgent' }
    if (issue.retryAt !== undefined) {
      const at = autoRetryEnabled && resumeAt !== undefined ? resumeAt : issue.retryAt
      if (now < at) return { text: `Retry in ${relativeRetryTime(at)}`, tone: 'urgent' }
    }
    return { text: 'Stopped', tone: 'urgent' }
  })

  /**
   * Open the shared sign-in panel for this thread's account.
   *
   * The account binding is explicit: this card is about the account the thread
   * is running on, so the sign-in must write into that account's credential
   * home. An unbound login writes the harness's shared store, where the fresh
   * credential lands on another account row while the expired one stays signed
   * out. The panel picks the mechanism (in-app for a harness with no CLI to hand
   * a terminal, the login terminal otherwise) from the harness's capabilities.
   */
  function beginSignIn(): void {
    signInAccountId = settings?.accountId
    signInProviderId = settings?.providerId
    signInOpen = true
  }

  /**
   * The credential changed, so the account list and every catalog discovered
   * through it are stale for this harness. The card then clears and the thread
   * retries, mirroring a successful sign-in from the provider manager.
   */
  function signedIn(): void {
    signInOpen = false
    harnessAccountCache.invalidate(issue.harnessId)
    providerCatalog.invalidateAll()
    ;(onSignedIn ?? onRetry)?.()
  }

  /** Commit a new thread model from the shared picker, mirroring the pattern used
   *  by the Audit/Spec/Assignment cards. Fast inference only survives the switch
   *  when the newly selected model actually exposes a fast tier. */
  function chooseModel(
    providerId: string,
    modelId: string,
    nextHarnessId?: string,
    accountId?: string
  ): void {
    if (!settings || !onModelChange) return
    const harnessId = nextHarnessId ?? settings.harnessId
    const provider = providers.find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    const updated = normalizeFastInference(
      { ...settings, harnessId, accountId, providerId, modelId },
      harnessId,
      providerId,
      modelId,
      supportsFastInference(harnessId, providerId, model?.fastSupported)
    )
    onModelChange(updated)
  }

  function chooseThinking(level: ThinkingLevel): void {
    if (!settings || !onModelChange) return
    onModelChange({ ...settings, thinkingLevel: level })
  }

  function chooseRuntime(runtime: import('$shared/types').ModelRuntimeSettings): void {
    if (!settings || !onModelChange) return
    onModelChange({ ...settings, ...runtime })
  }
</script>

import CioTimerReset from

<!-- The live region wraps the frame so a status change still announces the whole
card, the way it did before the head moved onto the shared primitives. -->
<div role={waiting ? 'status' : 'alert'} aria-live="polite">
  <CardFrame placement="top" label="Provider status" {stackedAbove} {joinsBelow}>
    <CardHead
      icon={waiting || autoResume ? CioClock : CioAttention}
      title={sourceLabel ? 'Worker output error' : title}
      {chip}
      bind:folded={foldState.folded}
      foldLabel="provider status"
    >
      {#snippet meta()}
        <CardTag text={providerName} />
        {#if sourceLabel}
          <CardTag text={`Worker · ${sourceLabel}`} tone="err" />
        {/if}
      {/snippet}
    </CardHead>

    {#if !foldState.folded}
      <div
        transition:slide={foldSlide()}
        class="flex flex-col gap-2 px-3 py-2.5 text-xs leading-relaxed text-muted"
      >
        {#if sourceDetail}
          <p class="font-medium text-foreground">Task · {sourceDetail}</p>
        {/if}

        <p class="select-text">
          {#each messageParts(displayMessage) as part, index (index)}
            {#if part.isLink}
              <a
                href={part.text}
                target="_blank"
                rel="noopener noreferrer"
                class="break-all text-accent underline underline-offset-2 hover:text-accent/80"
                >{part.text}</a
              >
            {:else}
              {part.text}
            {/if}
          {/each}
        </p>

        {#if waiting && issue.kind === 'network'}
          <p class="font-medium text-foreground">
            Waiting for connection. Will resume automatically when the device reconnects.
          </p>
        {:else if autoRetryEnabled && resumeAt !== undefined}
          <p class="flex items-center gap-1.5 font-medium text-info tabular-nums">
            <CioTimerReset size={13} class="shrink-0" aria-hidden="true" />
            {#if queued}
              Queued for auto-resume
            {:else}
              Auto-resume {formatDateTimeWithWeekday(resumeAt)} · in {relativeRetryTime(resumeAt)}
            {/if}
            {#if issue.attempt}
              · attempt {issue.attempt}
            {/if}
          </p>
        {:else if issue.retryAt}
          <p class="font-medium text-foreground tabular-nums">
            Available again {formatDateTimeWithWeekday(issue.retryAt)}
          </p>
        {:else if waiting}
          <p class="font-medium text-foreground">
            Automatic retry is not scheduled. Retry now when the provider is ready.
          </p>
        {/if}
      </div>
    {/if}

    {#if !foldState.folded}
      <CardFoot>
        {#snippet left()}
          {#if !waiting && onDismiss}
            <CardButton
              label="Dismiss"
              title="Dismiss provider error"
              icon={CioClose}
              variant="ghost"
              onclick={onDismiss}
            />
          {/if}
          {#if waiting && onStop}
            <CardButton
              label="Stop request"
              title="Stop the waiting request"
              icon={CioSquare}
              variant="ghost-danger"
              disabled={retrying}
              onclick={onStop}
            />
          {/if}
          {#if !waiting && rawError}
            <CardButton
              label="Raw Error"
              title="Show the raw provider error"
              icon={CioCode}
              variant="ghost"
              onclick={() => (showRawError = true)}
            />
          {/if}
        {/snippet}

        {#snippet right()}
          {#if settings && providers.length > 0 && onModelChange}
            <ModelPicker
              {providers}
              {projectId}
              harnessId={settings.harnessId}
              providerId={settings.providerId}
              modelId={settings.modelId}
              accountId={settings.accountId}
              {favoriteModels}
              {recentModels}
              {onRemoveRecent}
              side="top"
              label="Change"
              variant="action"
              onSelect={chooseModel}
              thinkingLevel={settings.thinkingLevel}
              runtimeSettings={settings}
              onSelectThinking={chooseThinking}
              onSelectRuntime={chooseRuntime}
              {onToggleFavorite}
              {onReorderFavorite}
            />
          {/if}

          {#if issue.kind === 'authentication'}
            {#if !waiting && onRetry}
              <CardButton
                label={retryLabel}
                title={retryLabel}
                icon={retrying ? undefined : CioUndo}
                variant="secondary"
                loading={retrying}
                disabled={retrying}
                onclick={() => void onRetry?.()}
              />
            {/if}
            <CardButton
              label="Sign in"
              title="Sign in to the AI account"
              icon={CioLogIn}
              variant="primary"
              onclick={beginSignIn}
            />
          {:else if waiting && onRetry}
            <CardButton
              label="Retry now"
              title="Retry the request now"
              icon={retrying ? undefined : CioUndo}
              variant="primary"
              loading={retrying}
              disabled={retrying}
              onclick={() => void onRetry?.()}
            />
          {:else if !waiting && onRetry}
            <CardButton
              label={retryLabel}
              title={retryLabel}
              icon={retrying ? undefined : CioUndo}
              variant="primary"
              loading={retrying}
              disabled={retrying}
              onclick={() => void onRetry?.()}
            />
          {/if}
        {/snippet}
      </CardFoot>
    {/if}
  </CardFrame>
</div>

{#if rawError}
  <Modal
    open={showRawError}
    title={`${providerName} Raw Error`}
    onClose={() => (showRawError = false)}
  >
    <button
      class="mb-2 inline-flex h-8 items-center gap-1.5 border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
      aria-label={copiedRawError ? 'Raw error copied' : 'Copy raw error to clipboard'}
      title={copiedRawError ? 'Copied' : 'Copy raw error'}
      onclick={() => void copyRawError()}
    >
      {#if copiedRawError}
        <CioCheck size={13} class="text-success" />
        Copied
      {:else}
        <CioCopy size={13} />
        Copy
      {/if}
    </button>
    <pre
      class="max-h-96 overflow-auto border border-border bg-raised p-3 text-xs leading-relaxed text-foreground"><code
        >{rawError}</code
      ></pre>
  </Modal>
{/if}

{#if signInOpen}
  <ProviderSignInPanel
    harnessId={issue.harnessId}
    harnessName={providerName}
    providerId={signInProviderId}
    accountId={signInAccountId}
    onClose={() => (signInOpen = false)}
    onComplete={signedIn}
  />
{/if}
