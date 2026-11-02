<script lang="ts">
  import CioLogIn from '@pdslng/cio-icon/CioLogIn.svelte'
  import CioPlug from '@pdslng/cio-icon/CioPlug.svelte'
  import { onDestroy } from 'svelte'
  import { createSubscriber } from 'svelte/reactivity'
  import { fly, slide } from 'svelte/transition'
  import DeferredMarkdownView from '../markdown/DeferredMarkdownView.svelte'
  import CardButton from '../shared/CardButton.svelte'
  import CardCloseButton from '../shared/CardCloseButton.svelte'
  import CardFoot from '../shared/CardFoot.svelte'
  import CardHead from '../shared/CardHead.svelte'
  import { cardFrameClass } from '../shared/card-frame'
  import { dismissSlide, foldSlide, rowArrive } from '../shared/card-motion'
  import { formatRemaining } from '../shared/card-timer'
  import { McpOAuthController } from '../settings/utility-editor-modal-mcp-oauth.svelte'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { MCP_SIGN_IN_COMPLETED_ANSWER } from '$shared/mcp-sign-in'
  import type { PendingAgentQuestionRequest } from '$shared/types'

  interface Props {
    request: PendingAgentQuestionRequest
    /** Tells the main process the sign-in finished, which settles the waiting tool call. */
    onSubmit: (requestId: string, answer: string) => Promise<void>
    /** Declines the sign-in, so the agent continues without this server. */
    onDismiss: (requestId: string) => Promise<void>
    /** Holds the countdown while the browser flow runs; the user is elsewhere. */
    onPause?: (requestId: string, questionIndex: number) => Promise<void>
  }

  let { request, onSubmit, onDismiss, onPause }: Props = $props()

  // The parent keys this component by request id, so the target below belongs to
  // one authoritative pending request for the lifetime of the component.
  // svelte-ignore state_referenced_locally
  const target = request.questions[0]?.mcpSignIn
  const iconHost = target?.iconHost
  // A server's own icon is the fastest way to recognise it, and it is resolved
  // through main because the renderer may not load remote images. Asked for once,
  // for the one host this card is about; a server without an icon simply has none.
  if (iconHost) faviconState.ensureResolved([`https://${iconHost}`])

  // The sign-in runs through the same controller the Utilities page uses, so
  // there is one authorization path in the app and one grant behind it.
  const oauth = new McpOAuthController({ utility: () => null, onChanged: () => undefined })
  // The controller holds the server it is authorizing, so it is told which one the
  // moment the card appears: signing in is a single click and must not depend on a
  // later read having landed first.
  if (target) void oauth.load(target.utilityId)
  onDestroy(() => oauth.dispose())

  let working = $state(false)
  let actionError = $state('')
  let folded = $state(false)

  let iconUrl = $derived(iconHost ? faviconState.faviconFor(`https://${iconHost}`) : null)
  // The prompt and the explanation are the question's own body, so the card reads
  // exactly what the main process asked and nothing is retyped here.
  let prompt = $derived(request.questions[0]?.prompt ?? 'Sign in')
  let description = $derived(request.questions[0]?.description ?? '')
  let progress = $derived(oauth.progress)
  let failure = $derived(actionError || oauth.error || '')

  // The request carries its own deadline, so the countdown is the same one the
  // main process runs. Time is an external system, so it is subscribed to rather
  // than tracked in an effect.
  const subscribeToClock = createSubscriber((update) => {
    const timer = window.setInterval(update, 1_000)
    return () => window.clearInterval(timer)
  })
  let remainingMs = $derived.by(() => {
    if (request.expiresAt === undefined) return null
    subscribeToClock()
    return Math.max(0, request.expiresAt - Date.now())
  })
  // The card holds no deadline once the browser flow starts or the user touched
  // it: the flow takes as long as the authorization server takes, and nothing
  // counts down under someone who is signing in.
  let timerPaused = $derived(remainingMs === null && request.interactedQuestionIndexes.length > 0)
  let remainingLabel = $derived.by(() => {
    if (remainingMs !== null) return formatRemaining(remainingMs)
    return timerPaused ? 'Paused' : 'No deadline'
  })
  let timerTone = $derived<'default' | 'paused' | 'urgent'>(
    remainingMs === null ? 'paused' : remainingMs <= 60_000 ? 'urgent' : 'default'
  )
  let timerTitle = $derived(
    remainingMs === null
      ? timerPaused
        ? 'The countdown is paused while you sign in'
        : 'This request has no deadline'
      : 'The card closes when the time runs out; the agent will continue without this server'
  )

  /**
   * Hold the countdown before the browser flow starts: the authorization page,
   * the account chooser and the provider's own redirect all happen outside this
   * app, and a card that expired in the middle would report a decline the user
   * never made. Best-effort, exactly like the secret card, so the sign-in always
   * starts.
   */
  function pauseCountdown(): void {
    if (!onPause) return
    void onPause(request.requestId, 0).catch(() => undefined)
  }

  /**
   * Sign in through the shared OAuth flow and report the result.
   *
   * The authorization page opens in whichever browser the user's link routing
   * says (`openSignInPage`), the grant lands in the encrypted vault, and only a
   * grant the server actually accepted settles the waiting tool call. Anything
   * else leaves the card up with the reason, so the user can retry or decline.
   */
  async function signIn(): Promise<void> {
    if (working || !target) return
    pauseCountdown()
    working = true
    actionError = ''
    try {
      await oauth.authorize()
      if (oauth.status?.state === 'connected') {
        await onSubmit(request.requestId, MCP_SIGN_IN_COMPLETED_ANSWER)
        return
      }
      actionError =
        oauth.error ?? 'The sign-in did not finish. Try again, or continue without this server.'
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'The sign-in could not be completed.'
    }
    working = false
  }

  /** Stop a running browser flow; the card stays up for another attempt. */
  async function cancelSignIn(): Promise<void> {
    if (!working) return
    await oauth.cancel()
    working = false
  }

  async function decline(): Promise<void> {
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
  aria-label="MCP server sign-in request"
>
  <!-- The card that takes the composer's place while an MCP server waits for the
     user to authorize it: which server asked, why, and the one action that ends it. -->
  <CardHead
    icon={CioPlug}
    title="MCP authorization"
    chip={{
      text: remainingLabel,
      tone: timerTone,
      title: timerTitle,
      label: timerPaused ? 'The countdown is paused' : `Time remaining: ${remainingLabel}`
    }}
    foldLabel="sign-in request"
    bind:folded
  >
    {#snippet controls()}
      <CardCloseButton
        title="Dismiss this sign-in request"
        disabled={working}
        onclick={() => void decline()}
      />
    {/snippet}
  </CardHead>

  {#if !folded}
    <div transition:slide={foldSlide()}>
      <div class="space-y-3 p-4">
        <div class="flex items-start gap-2">
          {#if iconUrl}
            <img
              src={iconUrl}
              alt=""
              aria-hidden="true"
              class="mt-0.5 h-5 w-5 shrink-0 object-contain"
            />
          {:else}
            <CioPlug size={16} class="mt-0.5 shrink-0 text-muted" />
          {/if}
          <div class="min-w-0 space-y-0.5">
            <p class="truncate text-sm font-semibold text-foreground" title={target?.name}>
              {target?.name ?? 'MCP server'}
            </p>
            {#if target?.endpoint}
              <p class="truncate font-mono text-xs text-muted" title={target.endpoint}>
                {target.endpoint}
              </p>
            {/if}
          </div>
        </div>

        <div class="space-y-1">
          <p class="text-sm text-foreground">{prompt}</p>
          {#if description}
            <div class="text-xs text-muted">
              <DeferredMarkdownView text={description} class="markdown-body-card" />
            </div>
          {/if}
        </div>

        {#if progress}
          <p class="text-xs text-muted" aria-live="polite">{progress}</p>
        {/if}

        {#if failure}
          <p
            class="bg-danger/10 px-3 py-2 text-xs text-danger"
            role="alert"
            transition:fly={rowArrive()}
          >
            {failure}
          </p>
        {/if}
      </div>
    </div>
  {/if}

  <CardFoot>
    {#snippet left()}
      <CardButton
        label="Not now"
        title="Continue without this server and skip the sign-in"
        variant="ghost"
        disabled={working}
        onclick={() => void decline()}
      />
    {/snippet}
    {#snippet right()}
      {#if working}
        <CardButton
          label="Cancel"
          title="Stop waiting for the browser"
          variant="secondary"
          onclick={() => void cancelSignIn()}
        />
      {/if}
      <CardButton
        label={working ? 'Waiting for browser…' : 'Sign in'}
        title="Open the authorization page and sign this server in"
        icon={CioLogIn}
        variant="primary"
        loading={working}
        disabled={working}
        onclick={() => void signIn()}
      />
    {/snippet}
  </CardFoot>
</section>
