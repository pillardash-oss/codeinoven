<script lang="ts">
  import {
    Check,
    Copy,
    ExternalLink,
    Globe,
    Loader2,
    TimerOff,
    TriangleAlert,
    X
  } from '@lucide/svelte'
  import { APP_SLUG } from '$shared/brand'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'

  /**
   * GitHub sign-in as a dockable panel, mounted at the app root so the flow
   * outlives the view it was opened from.
   *
   * The panel is not a modal on purpose: authorizing happens on github.com, so
   * the user leaves for a browser and the panel has to be able to get out of the
   * way and keep polling while they are there.
   *
   * The app-wide browser is the destination that makes signing in inside
   * CodeInOven possible, and it is also the one place the panel cannot be drawn
   * over: its page is a native `WebContentsView` the compositor paints above
   * every DOM node, so a panel or chip covering it parks the page
   * (`src/renderer/lib/stores/browser-visibility.svelte.ts`). While the sign-in
   * is parked in its dock and the browser holding the page it opened is the view
   * in front, both step out of the DOM entirely, which is exactly what leaves
   * that page usable; the panel returns by itself the moment the flow resolves.
   * The code is on the clipboard by then, and the store docks the panel only once
   * the browser reports that it really holds the page, so the two cannot come
   * apart: no page, no step-aside.
   */

  /** The panel's own dock: this is the only surface that owns this placement. */
  const storageKey = `${APP_SLUG}.githubSignIn.v1`

  /** Whether the flow has stopped being something the user waits on. */
  const settled = $derived(!githubSignIn.waiting)

  const onScreen = $derived(
    githubSignIn.open &&
      !(
        githubSignIn.minimized &&
        githubSignIn.handedOffToAppBrowser &&
        rendererRecovery.activeView === 'browser'
      )
  )

  const statusLabel = $derived.by(() => {
    switch (githubSignIn.phase) {
      case 'starting':
        return 'Starting'
      case 'waiting':
        return githubSignIn.copied ? 'Code copied, waiting' : 'Waiting for authorization'
      case 'authorized':
        return 'Signed in'
      case 'expired':
        return 'Code expired'
      default:
        return 'Sign-in failed'
    }
  })

  const restoreLabel = $derived(`Show GitHub sign-in (${statusLabel.toLowerCase()})`)

  /**
   * What the chip's dismiss affordance says.
   *
   * While the flow is in flight, dropping the panel can only mean abandoning the
   * attempt the user started, so the label says cancel. Once it settled there is
   * nothing left to abandon and the same control just closes the panel.
   */
  const dismissLabel = $derived(
    settled ? 'Close GitHub sign-in' : 'Cancel this sign-in and stop waiting for the code'
  )
</script>

<DockableModal
  open={onScreen}
  title="Sign in to GitHub"
  minimized={githubSignIn.minimized}
  closable={settled}
  onMinimize={() => githubSignIn.minimize()}
  onClose={() => githubSignIn.close()}
  {storageKey}
  dragLabel="Drag to move the GitHub sign-in panel"
  defaultHeight={420}
>
  {#snippet dock()}
    <DockRow {storageKey} label="Move docked GitHub sign-in">
      <div class="flex items-center gap-1 rounded-xl border bg-surface p-1.5 shadow-xl">
        <button
          type="button"
          class="flex min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title={restoreLabel}
          aria-label={restoreLabel}
          onclick={() => githubSignIn.expand()}
        >
          <VendorIcon name="GitHub" size={14} class="shrink-0 text-dimmed" />
          <span class="flex min-w-0 flex-col">
            <span class="text-[0.625rem] font-medium leading-tight text-foreground">Sign in</span>
            <span class="max-w-40 truncate text-[0.5625rem] leading-tight text-muted">
              {statusLabel}
            </span>
          </span>
          {#if githubSignIn.waiting}
            <Loader2 size={11} class="shrink-0 animate-spin text-info" aria-hidden="true" />
          {:else if githubSignIn.phase === 'authorized'}
            <Check size={11} class="shrink-0 text-success" aria-hidden="true" />
          {:else if githubSignIn.phase === 'expired'}
            <TimerOff size={11} class="shrink-0 text-warning" aria-hidden="true" />
          {:else}
            <TriangleAlert size={11} class="shrink-0 text-danger" aria-hidden="true" />
          {/if}
        </button>
        <span class="h-5 w-px bg-border"></span>
        <button
          type="button"
          class="flex h-8 w-8 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={dismissLabel}
          title={dismissLabel}
          onclick={() => githubSignIn.close()}
        >
          <X size={14} />
        </button>
      </div>
    </DockRow>
  {/snippet}

  {#if githubSignIn.phase === 'starting'}
    <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
      <Loader2 size={14} class="animate-spin" aria-hidden="true" />
      Starting sign-in…
    </div>
  {:else if githubSignIn.phase === 'waiting' && githubSignIn.device}
    <div class="space-y-4">
      <p class="flex items-start gap-2 text-xs leading-relaxed text-muted">
        <VendorIcon name="GitHub" size={14} class="mt-0.5 shrink-0 text-foreground" />
        Enter this code on GitHub to connect your account.
      </p>

      <button
        type="button"
        class="flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-border bg-elevated px-4 py-3 transition-colors hover:border-muted"
        title="Copy the code"
        aria-label="Copy the device code"
        onclick={() => void githubSignIn.copyCode()}
      >
        <span class="select-all font-mono text-3xl font-semibold tracking-[0.2em] text-foreground">
          {githubSignIn.device.userCode}
        </span>
        {#if githubSignIn.copied}
          <Check size={16} class="text-success" />
        {:else}
          <Copy size={16} class="text-dimmed" />
        {/if}
      </button>

      {#if githubSignIn.copyError}
        <p role="alert" class="text-center text-[0.625rem] text-danger">{githubSignIn.copyError}</p>
      {/if}

      <p class="text-center text-[0.625rem] leading-relaxed text-dimmed">
        Signing in inside CodeInOven copies the code and steps this panel aside while you authorize.
      </p>

      <p
        class="flex items-center justify-center gap-1.5 text-[0.625rem] text-dimmed"
        aria-live="polite"
      >
        <Loader2 size={11} class="animate-spin" />
        {#if githubSignIn.remaining > 0}
          Waiting for you to authorize… code expires in {githubSignIn.countdown}
        {:else}
          Waiting for you to authorize…
        {/if}
      </p>
    </div>
  {:else if githubSignIn.phase === 'authorized'}
    <div class="flex flex-col items-center justify-center py-8 text-center">
      <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-success/10">
        <Check size={18} class="text-success" />
      </div>
      <p class="text-xs font-medium text-foreground">Signed in to GitHub</p>
      <p class="mt-1 text-[0.625rem] text-dimmed">
        Pull requests and sync now use your GitHub account.
      </p>
    </div>
  {:else if githubSignIn.phase === 'expired'}
    <div class="flex flex-col items-center justify-center py-8 text-center">
      <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-warning/10">
        <TimerOff size={18} class="text-warning" />
      </div>
      <p class="text-xs font-medium text-foreground">Code expired</p>
      <p class="mt-1 max-w-[30ch] text-[0.625rem] leading-relaxed text-dimmed">
        The sign-in code expired before it was authorized. Try again with a fresh code.
      </p>
    </div>
  {:else}
    <div class="flex flex-col items-center justify-center py-8 text-center">
      <p class="text-xs font-medium text-danger">Sign-in failed</p>
      {#if githubSignIn.message}
        <p class="mt-1 max-w-[34ch] text-[0.625rem] leading-relaxed text-dimmed">
          {githubSignIn.message}
        </p>
      {/if}
    </div>
  {/if}

  <!--
    The destinations stay in the footer in every in-flight phase, disabled until
    GitHub hands the code over, so the panel does not grow a second action row the
    moment the flow starts. Both are also held while the in-app hand-off is in
    flight: the page it is waiting for is the answer to the click, and a second
    destination started underneath it would race it. Cancel stays available
    throughout, which is the panel's way out of a flow the user no longer wants.
  -->
  {#snippet footer()}
    {#if settled}
      <button
        type="button"
        data-modal-primary
        class="flex h-8 cursor-pointer items-center justify-center rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover"
        onclick={() =>
          githubSignIn.phase === 'authorized' ? githubSignIn.close() : githubSignIn.start()}
      >
        {githubSignIn.phase === 'authorized' ? 'Done' : 'Try again'}
      </button>
    {:else}
      <!--
        In flight the panel had no exit: the header withholds its close affordance
        until the flow settles (`closable={settled}`) and Escape only minimizes, so
        a user who changed their mind was left watching a code they do not intend
        to enter until GitHub expired it. This is that exit, on the footer's left
        edge where a dismiss action belongs, and `data-modal-dismiss` keeps it out
        of the ⌘/Ctrl+Enter primary-action lookup.
      -->
      <button
        type="button"
        data-modal-dismiss
        class="mr-auto cursor-pointer rounded-lg px-3 py-1.5 text-[0.6875rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Cancel this sign-in and stop waiting for the code"
        aria-label="Cancel this sign-in"
        onclick={() => githubSignIn.close()}
      >
        Cancel
      </button>
      <button
        type="button"
        class="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[0.6875rem] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
        title="Open the GitHub verification page in your default browser"
        disabled={!githubSignIn.device || githubSignIn.handingOffToAppBrowser}
        onclick={() => void githubSignIn.openInDefaultBrowser()}
      >
        <ExternalLink size={13} />
        Open in Default Browser
      </button>
      <button
        type="button"
        data-modal-primary
        class="flex h-8 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
        title="Sign in inside CodeInOven: opens the verification page in the app-wide browser and copies the code"
        disabled={!githubSignIn.device || githubSignIn.handingOffToAppBrowser}
        onclick={() => void githubSignIn.openInCioBrowser()}
      >
        {#if githubSignIn.handingOffToAppBrowser}
          <!--
            The browser's modules and its durable tab list are read before the
            page can be shown, so this is not instant. The wait is visible here
            because the alternative is a click that looks like it did nothing,
            which is exactly what a user reported when the hand-off was silent.
          -->
          <Loader2 size={13} class="animate-spin" />
          Opening…
        {:else}
          <Globe size={13} />
          Open in Global CIO Browser
        {/if}
      </button>
    {/if}
  {/snippet}
</DockableModal>
