<script lang="ts">
  import {
    AlertTriangle,
    Clock3,
    Code2,
    Loader2,
    LogIn,
    RotateCcw,
    Square,
    X
  } from '@lucide/svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import type {
    AgentProviderIssueKind,
    AgentSessionStatus,
    ProviderAccountLoginHandoff,
    ProviderCatalog,
    ThreadSettings
  } from '$shared/types'
  import { invoke } from '$lib/ipc.svelte'
  import Modal from '../ui/Modal.svelte'
  import ProviderLoginTerminal from '../providers/ProviderLoginTerminal.svelte'

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
    onReorderFavorite?: (
      draggedKey: string,
      targetKey: string,
      position: 'before' | 'after'
    ) => void
    onStop?: () => void
    onRetry?: () => void
    onDismiss?: () => void
    sourceLabel?: string
    sourceDetail?: string
    retryLabel?: string
    retrying?: boolean
    /** Whether the app auto-resumes this thread once the reset time passes. */
    autoRetryEnabled?: boolean
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
    onReorderFavorite,
    onStop,
    onRetry,
    onDismiss,
    sourceLabel,
    sourceDetail,
    retryLabel = 'Retry',
    retrying = false,
    autoRetryEnabled = true
  }: Props = $props()
  let now = $state(Date.now())
  let showRawError = $state(false)
  let loginOpen = $state(false)
  let loginHandoff = $state<ProviderAccountLoginHandoff | null>(null)
  let loginError = $state('')
  let loginTerminalId = $state('')
  const issue = $derived(status.issue)
  const rawError = $derived(issue.rawError?.trim() || issue.message.trim())
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

  $effect(() => {
    if (!issue.retryAt) return
    now = Date.now()
    const timer = window.setInterval(() => {
      now = Date.now()
    }, 1_000)
    return () => window.clearInterval(timer)
  })

  function issueTitle(kind: AgentProviderIssueKind): string {
    switch (kind) {
      case 'rate_limit':
      case 'quota':
        return 'Usage limit reached'
      case 'authentication':
        return 'Provider sign-in required'
      case 'billing':
        return 'Provider billing issue'
      case 'provider_unavailable':
        return 'Provider temporarily unavailable'
      case 'network':
        return 'Provider connection interrupted'
      default:
        return waiting ? 'Provider retry scheduled' : 'Agent output error'
    }
  }

  function relativeRetryTime(retryAt: number): string {
    const remainingSeconds = Math.max(0, Math.ceil((retryAt - now) / 1_000))
    if (remainingSeconds < 60) return `${remainingSeconds}s`
    const minutes = Math.ceil(remainingSeconds / 60)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const remainingMinutes = minutes % 60
    if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`
    const days = Math.floor(hours / 24)
    const remainingHours = hours % 24
    return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`
  }

  function absoluteRetryTime(retryAt: number): string {
    return new Date(retryAt).toLocaleString([], {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  async function beginSignIn(): Promise<void> {
    loginError = ''
    loginHandoff = null
    loginTerminalId = `provider-login-${crypto.randomUUID()}`
    loginOpen = true
    try {
      loginHandoff = await invoke('providerAccounts:beginLogin', issue.harnessId, {
        mode: 'default'
      })
    } catch (error) {
      loginError = error instanceof Error ? error.message : 'Sign-in could not be started.'
    }
  }

  function closeSignIn(): void {
    loginOpen = false
    loginHandoff = null
    loginError = ''
  }

  /** Commit a new thread model from the shared picker, mirroring the pattern used
   *  by the Audit/Spec/Assignment cards. */
  function chooseModel(providerId: string, modelId: string, nextHarnessId?: string): void {
    if (!settings || !onModelChange) return
    const harnessId = nextHarnessId ?? settings.harnessId
    onModelChange({ ...settings, harnessId, providerId, modelId })
  }

  function finishSignIn(exitCode: number): void {
    if (exitCode !== 0) {
      loginError = `Sign-in exited with code ${exitCode}.`
      return
    }
    closeSignIn()
    onRetry?.()
  }
</script>

<div
  class={[
    'rounded-xl border px-4 py-3',
    waiting || autoResume ? 'border-warning/25 bg-warning/5' : 'border-danger/20 bg-danger/5'
  ]}
  role={waiting ? 'status' : 'alert'}
  aria-live="polite"
>
  <div class="flex items-start gap-3">
    {#if waiting || autoResume}
      <Clock3 size={16} class="mt-0.5 shrink-0 text-warning" />
    {:else}
      <AlertTriangle size={16} class="mt-0.5 shrink-0 text-danger" />
    {/if}

    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p class="text-sm font-semibold text-foreground">
          {sourceLabel ? 'Worker output error' : issueTitle(issue.kind)}
        </p>
        <span class="rounded-full bg-raised px-2 py-0.5 text-[10px] font-semibold text-muted">
          {providerName}
        </span>
        {#if sourceLabel}
          <span class="rounded-full bg-danger/10 px-2 py-0.5 text-[10px] font-semibold text-danger">
            Worker · {sourceLabel}
          </span>
        {/if}
      </div>

      {#if sourceDetail}
        <p class="mt-1 text-xs font-medium text-foreground">Task · {sourceDetail}</p>
      {/if}

      <p class="mt-1 text-sm leading-relaxed text-muted">{issue.message}</p>

      {#if waiting && issue.retryAt}
        <p class="mt-2 text-xs font-medium text-foreground tabular-nums">
          Retrying {absoluteRetryTime(issue.retryAt)} · in {relativeRetryTime(issue.retryAt)}
          {#if issue.attempt}
            · attempt {issue.attempt}
          {/if}
        </p>
      {:else if autoResume && issue.retryAt}
        <p class="mt-2 text-xs font-medium text-foreground tabular-nums">
          {#if autoRetryEnabled}
            Auto-resume {absoluteRetryTime(issue.retryAt)} · in {relativeRetryTime(issue.retryAt)}
          {:else}
            Available again {absoluteRetryTime(issue.retryAt)} · in {relativeRetryTime(
              issue.retryAt
            )}
          {/if}
        </p>
      {:else if issue.retryAt}
        <p class="mt-2 text-xs font-medium text-foreground tabular-nums">
          Available again {absoluteRetryTime(issue.retryAt)} · in {relativeRetryTime(issue.retryAt)}
        </p>
      {:else if waiting}
        <p class="mt-2 text-xs font-medium text-foreground">
          {providerName} will retry automatically.
        </p>
      {/if}

      <div class="mt-3 flex flex-wrap items-center gap-2">
        {#if !waiting && issue.kind === 'authentication'}
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
            onclick={() => void beginSignIn()}
          >
            <LogIn size={13} />
            Sign in
          </button>
        {/if}
        {#if waiting && onStop}
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
            onclick={onStop}
          >
            <Square size={12} />
            Stop request
          </button>
        {:else if !waiting && issue.kind !== 'authentication' && onRetry}
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
            disabled={retrying}
            onclick={onRetry}
          >
            {#if retrying}
              <Loader2 size={13} class="animate-spin" />
            {:else}
              <RotateCcw size={13} />
            {/if}
            {retrying ? 'Retrying…' : retryLabel}
          </button>
        {/if}
        {#if !waiting && settings && providers.length > 0 && onModelChange}
          <ModelPicker
            {providers}
            {projectId}
            harnessId={settings.harnessId}
            providerId={settings.providerId}
            modelId={settings.modelId}
            {favoriteModels}
            {recentModels}
            side="top"
            label="Change"
            variant="action"
            onSelect={chooseModel}
            {onToggleFavorite}
            {onReorderFavorite}
          />
        {/if}
        {#if !waiting && rawError}
          <button
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-xs font-medium text-foreground transition-colors hover:bg-elevated"
            onclick={() => (showRawError = true)}
          >
            <Code2 size={13} />
            Raw Error
          </button>
        {/if}
      </div>
    </div>

    {#if !waiting && onDismiss}
      <button
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Dismiss provider error"
        title="Dismiss"
        onclick={onDismiss}
      >
        <X size={14} />
      </button>
    {/if}
  </div>
</div>

{#if rawError}
  <Modal
    open={showRawError}
    title={`${providerName} Raw Error`}
    onClose={() => (showRawError = false)}
  >
    <pre
      class="max-h-96 overflow-auto rounded-lg border border-border bg-raised p-3 text-xs leading-relaxed text-foreground"><code
        >{rawError}</code
      ></pre>
  </Modal>
{/if}

<Modal open={loginOpen} title={`Sign in to ${providerName}`} onClose={closeSignIn}>
  <div class="h-[28rem] overflow-hidden rounded-lg border border-border bg-app">
    {#if loginHandoff}
      <ProviderLoginTerminal
        terminalId={loginTerminalId}
        command={loginHandoff.command}
        args={loginHandoff.args}
        onExit={finishSignIn}
      />
    {:else if loginError}
      <div class="flex h-full items-center justify-center p-6">
        <p class="max-w-md text-center text-sm text-danger">{loginError}</p>
      </div>
    {:else}
      <div class="flex h-full items-center justify-center text-sm text-muted">
        Preparing sign-in…
      </div>
    {/if}
  </div>
</Modal>
