<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import { ShieldAlert } from '@lucide/svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { applyAppTypography } from '$lib/app-typography'
  import { TOAST_CARD_WIDTH } from '$shared/browser-overlay'
  import type {
    BrowserPermissionDecision,
    BrowserPermissionPromptContext,
    BrowserPermissionRequest
  } from '$shared/ipc-contract'

  /**
   * The browser permission prompt's card: one request, drawn as a card of the
   * app's own, in the shape and materials of a toast.
   *
   * The page is a native view that composites above every DOM surface of the app
   * window, so this prompt is a window of its own (`permission-prompt-window.ts`)
   * and its document is this component's only content. It is deliberately the
   * width of a toast card and built from the same tokens, title and description
   * hierarchy, and full-width button row the toaster draws, because the user
   * meets it where they meet a toast and it should read as the same surface
   * rather than as a second, foreign one.
   *
   * It is not a toast, though: it holds one decision open for as long as it takes
   * the user to make it, never auto-closes, and never stacks.
   *
   * Delivery is pull-based for the first paint and push after it. The document
   * invokes `browser:popupReady` once its listener is bound, and main answers
   * with the request on display; a push straight after load loses the race
   * against the document's own subscription.
   */

  let context = $state<BrowserPermissionPromptContext | null>(null)
  let allowButton: HTMLButtonElement | undefined

  /** The recommended answer's own attachment. `present` runs again for every
   *  request that replaces another, and the keyboard belongs on the recommended
   *  answer each time, so the element is captured here rather than bound. */
  const trackAllowButton: Attachment<HTMLButtonElement> = (node) => {
    allowButton = node
    node.focus()
    return () => {
      if (allowButton === node) allowButton = undefined
    }
  }

  /** What the site is asking for, in the app's own words. */
  function capability(request: BrowserPermissionRequest): string {
    if (request.permission === 'media' && request.mediaTypes.length > 0) {
      return request.mediaTypes
        .map((mediaType) => {
          if (mediaType === 'video') return 'the camera'
          if (mediaType === 'audio') return 'the microphone'
          return mediaType
        })
        .join(' and ')
    }
    return request.permission.replace(/-/g, ' ')
  }

  /** The quiet line under the request: whose browsing this is, and how many
   *  requests are queued behind the one on display. */
  function noteFor(prompt: BrowserPermissionPromptContext): string | null {
    const parts: string[] = []
    if (prompt.projectLabel) parts.push(prompt.projectLabel)
    if (prompt.queueSize > 1) parts.push(`${prompt.queueSize} requests waiting`)
    return parts.length > 0 ? parts.join(' · ') : null
  }

  /** Show a request, and put the keyboard on the decision a user most often
   *  makes. Called by the pull on first load and by every push after it. */
  function present(next: BrowserPermissionPromptContext | null): void {
    if (!next) return
    context = next
    void tick().then(() => allowButton?.focus())
  }

  function decide(decision: BrowserPermissionDecision): void {
    const current = context
    if (!current) return
    // Cleared first: the decision is out of the user's hands the moment it is
    // made, and main pushes the next queued request, if there is one, straight
    // back through `present`.
    context = null
    void invoke('browser:resolvePermission', current.request.id, decision).catch(() => {})
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    event.preventDefault()
    decide('dismiss')
  }

  /**
   * Follow the app's live appearance.
   *
   * The theme arrives as a query parameter, but that hint is the OS scheme while
   * the app theme is the user's own choice, so the document asks the config and
   * wears what the app window wears. The stylesheet's own defaults stand if the
   * config cannot be read.
   */
  async function followApp(): Promise<void> {
    try {
      const config = await invoke('config:get')
      const dark =
        config.theme === 'dark' ||
        (config.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
      document.documentElement.classList.toggle('dark', dark)
      applyAppTypography(document.documentElement, config)
    } catch {
      // The first-paint theme stays.
    }
  }

  onMount(() => {
    const unsubscribe = subscribe('browser:popup:permission', (request, popupContext) => {
      present({
        request,
        queueSize: popupContext.queueSize,
        projectLabel: popupContext.projectLabel,
        systemAccessDenied: popupContext.systemAccessDenied
      })
    })
    document.addEventListener('keydown', onKeydown)
    void followApp()
    void invoke('browser:popupReady')
      .then((ready) => present(ready))
      .catch(() => {})
    return () => {
      unsubscribe()
      document.removeEventListener('keydown', onKeydown)
    }
  })
</script>

{#if context}
  <div
    class="prompt-card flex flex-col gap-1.5 rounded-lg border bg-surface p-4 shadow-lg"
    role="alertdialog"
    aria-labelledby="browser-permission-title"
    style:width={`${TOAST_CARD_WIDTH}px`}
  >
    <div class="flex min-w-0 items-start gap-2">
      <span
        class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-warning/20 text-warning"
        aria-hidden="true"
      >
        <ShieldAlert size={15} stroke-width={2.25} />
      </span>
      <p
        id="browser-permission-title"
        class="line-clamp-3 min-w-0 flex-1 text-[0.8125rem] font-medium leading-normal text-foreground"
      >
        <span class="break-all">{context.request.origin}</span> wants to use {capability(
          context.request
        )}
      </p>
    </div>
    {#if noteFor(context)}
      <p class="truncate text-xs text-muted">{noteFor(context)}</p>
    {/if}
    {#if context.systemAccessDenied}
      <p class="text-xs text-danger">
        macOS blocked access. Enable camera or microphone access for CodeInOven in System Settings, then retry.
      </p>
    {/if}
    <div class="mt-0.5 flex gap-1.5" role="group" aria-label="Permission decision">
      <button
        type="button"
        class="h-6 min-w-0 flex-1 whitespace-nowrap bg-elevated px-1.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
        title="Refuse and remember: this permission will not be asked for again on this site"
        onclick={() => decide('deny')}
      >
        Don't allow
      </button>
      <button
        type="button"
        class="h-6 min-w-0 flex-1 whitespace-nowrap bg-elevated px-1.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground"
        title="Allow only this one request; ask again next time"
        onclick={() => decide('allow-once')}
      >
        Allow once
      </button>
      <button
        type="button"
        {@attach trackAllowButton}
        class="h-6 min-w-0 flex-1 whitespace-nowrap bg-primary px-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
        title={context.systemAccessDenied
          ? 'Retry macOS camera or microphone access for this request'
          : 'Allow and remember for this site until you reset permissions'}
        onclick={() => decide('allow')}
      >
        {context.systemAccessDenied ? 'Retry' : 'Allow'}
      </button>
    </div>
  </div>
{/if}

<style>
  /* The card is the only thing this window paints, so it enters with the lift a
     card of the app's own has when it appears. */
  .prompt-card {
    animation: prompt-card-in 140ms ease-out both;
  }

  @keyframes prompt-card-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .prompt-card {
      animation: none;
    }
  }
</style>
