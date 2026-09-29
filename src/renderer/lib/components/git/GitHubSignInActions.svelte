<script lang="ts">
  import { ExternalLink, Globe, Loader2 } from '@lucide/svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'

  /**
   * What the sign-in offers to do next, wherever it is presented.
   *
   * The same component serves the floating panel's footer
   * (`GitHubSignInDock`) and the browser's docked bar
   * (`GitHubSignInBrowserDock`), so a control cannot exist in one place and not
   * the other. It draws the row and the buttons, but no border, background or
   * padding: each host owns its own footer chrome.
   *
   * While an attempt is in flight the destinations are the answer to it, and
   * Cancel is the way out of one the user no longer wants. Once it settled there
   * is nothing left to abandon, so the same control closes the panel instead and
   * the only action left is the next step: a fresh code, or done.
   */
  const settled = $derived(!githubSignIn.waiting)
</script>

<div class="flex w-full flex-wrap items-center justify-end gap-2">
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
      until the flow settles (`closable`) and Escape only minimizes, so a user who
      changed their mind was left watching a code they do not intend to enter until
      GitHub expired it. This is that exit, on the footer's left edge where a
      dismiss action belongs, and `data-modal-dismiss` keeps it out of the
      ⌘/Ctrl+Enter primary-action lookup of whichever shell is presenting it.
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
          The browser's modules and its durable tab list are read before the page
          can be shown, so this is not instant. The wait is visible here because
          the alternative is a click that looks like it did nothing, which is
          exactly what a user reported when the hand-off was silent.
        -->
        <Loader2 size={13} class="animate-spin" />
        Opening…
      {:else}
        <Globe size={13} />
        Open in Global CIO Browser
      {/if}
    </button>
  {/if}
</div>
