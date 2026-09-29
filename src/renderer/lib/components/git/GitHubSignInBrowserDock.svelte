<script lang="ts">
  import {
    Check,
    ChevronDown,
    ChevronUp,
    Copy,
    Loader2,
    TimerOff,
    TriangleAlert,
    X
  } from '@lucide/svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import GitHubSignInActions from './GitHubSignInActions.svelte'
  import GitHubSignInBody from './GitHubSignInBody.svelte'

  /**
   * The GitHub sign-in, docked into the app-wide browser view, under the page.
   *
   * The browser's page is a native `WebContentsView` the compositor paints above
   * every DOM node, so nothing DOM-shaped can be drawn over it
   * (`src/renderer/lib/stores/browser-visibility.svelte.ts`). Signing in inside
   * CodeInOven is the one case where the user has to hold a code from the panel
   * and type it into that very page, so the panel is a row of the browser's page
   * column instead: in flow, which shrinks the page's rectangle exactly the way
   * the browser's find bar does
   * (`src/renderer/lib/components/browser/BrowserWorkspace.svelte`). The page
   * stays on screen and usable, and the code stays readable next to the box it
   * goes into, for as long as the flow runs.
   *
   * Collapsed, it is one row: the code with its copy control, where the attempt
   * stands, and the way out. Expanded, it carries the panel's own body and
   * actions, so nothing about the flow is reachable only from the floating panel.
   *
   * Rendered by `BrowserView` only while `dockedInAppBrowser` holds, which is also
   * exactly when the floating panel stands down, so one of the two is always
   * present and never both.
   */

  const collapsed = $derived(githubSignIn.minimized)
  const settled = $derived(!githubSignIn.waiting)
  const dismissLabel = $derived(
    settled ? 'Close GitHub sign-in' : 'Cancel this sign-in and stop waiting for the code'
  )
  const detailsLabel = $derived(collapsed ? 'Show the sign-in details' : 'Hide the sign-in details')
</script>

<div
  class="flex shrink-0 flex-col border-t border-border bg-surface"
  data-region="github-sign-in-dock"
>
  <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
    <VendorIcon name="GitHub" size={14} class="shrink-0 text-dimmed" />
    <span class="shrink-0 text-[0.6875rem] font-medium text-foreground">Sign in to GitHub</span>

    {#if collapsed && githubSignIn.phase === 'waiting' && githubSignIn.device}
      <!--
        The code stays in the row while the panel is collapsed, because that is the
        state the hand-off leaves it in and the page above is waiting for exactly
        this string. It is the same control the panel's body draws, at the size a
        row has room for.
      -->
      <button
        type="button"
        class="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 py-1 transition-colors hover:border-muted"
        title="Copy the code to paste into the GitHub page"
        aria-label="Copy the device code"
        onclick={() => void githubSignIn.copyCode()}
      >
        <span class="select-all font-mono text-xs font-semibold tracking-[0.15em] text-foreground">
          {githubSignIn.device.userCode}
        </span>
        {#if githubSignIn.copied}
          <Check size={12} class="text-success" aria-hidden="true" />
        {:else}
          <Copy size={12} class="text-dimmed" aria-hidden="true" />
        {/if}
      </button>
      <span class="hidden text-[0.625rem] text-dimmed lg:inline">
        Press {githubSignIn.pasteChord} in the page to paste it
      </span>
    {/if}

    <span
      class="ml-auto flex shrink-0 items-center gap-1.5 text-[0.625rem] text-muted"
      aria-live="polite"
    >
      {#if githubSignIn.waiting}
        <Loader2 size={11} class="shrink-0 animate-spin text-info" aria-hidden="true" />
      {:else if githubSignIn.phase === 'authorized'}
        <Check size={11} class="shrink-0 text-success" aria-hidden="true" />
      {:else if githubSignIn.phase === 'expired'}
        <TimerOff size={11} class="shrink-0 text-warning" aria-hidden="true" />
      {:else}
        <TriangleAlert size={11} class="shrink-0 text-danger" aria-hidden="true" />
      {/if}
      <!--
        The countdown sits beside the code that expires, not in the panel body,
        where it is only visible with the details open.
      -->
      <span>
        {githubSignIn.statusLabel}{#if githubSignIn.waiting && githubSignIn.remaining > 0}, {githubSignIn.countdown}
          left{/if}
      </span>
    </span>

    <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>

    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={detailsLabel}
      title={detailsLabel}
      onclick={() => (collapsed ? githubSignIn.expand() : githubSignIn.minimize())}
    >
      {#if collapsed}
        <ChevronUp size={14} />
      {:else}
        <ChevronDown size={14} />
      {/if}
    </button>
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={dismissLabel}
      title={dismissLabel}
      onclick={() => githubSignIn.close()}
    >
      <X size={14} />
    </button>
  </div>

  {#if !collapsed}
    <!--
      The body is capped rather than allowed to take the page's room: an attempt is
      a few lines tall, and a window short enough for the panel to crowd the page
      scrolls the details instead of shrinking the page to nothing.
    -->
    <div class="max-h-[38vh] shrink-0 overflow-y-auto border-t border-border">
      <div class="mx-auto w-full max-w-lg px-4 py-3">
        <GitHubSignInBody />
      </div>
    </div>
    <!-- The panel's own footer chrome, so the actions look the same in both shells. -->
    <div class="flex shrink-0 flex-wrap items-center gap-2 border-t bg-surface px-4 py-3">
      <GitHubSignInActions />
    </div>
  {/if}
</div>
