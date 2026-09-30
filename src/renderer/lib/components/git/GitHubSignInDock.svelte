<script lang="ts">
  import { Check, Loader2, TimerOff, TriangleAlert, X } from '@lucide/svelte'
  import { APP_SLUG } from '$shared/brand'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import GitHubSignInActions from './GitHubSignInActions.svelte'
  import GitHubSignInBody from './GitHubSignInBody.svelte'

  /**
   * GitHub sign-in as a floating, dockable panel, mounted at the app root so the
   * flow outlives the view it was opened from.
   *
   * The panel is not a modal on purpose: authorizing happens on github.com, so
   * the user leaves for a browser and the panel has to keep polling while they are
   * there. It is also not the panel that serves that browser: the app-wide
   * browser's page is a native `WebContentsView` the compositor paints above every
   * DOM node, so a floating panel or dock chip that covers it would park the page
   * the user is signing in on
   * (`src/renderer/lib/stores/browser-visibility.svelte.ts`). That view gets the
   * docked bar instead (`GitHubSignInBrowserDock`), which is what this panel
   * yields to through `dockedInAppBrowser`. Every other view floats this one,
   * exactly as a dockable panel should.
   *
   * The flow itself is not written here: `GitHubSignInBody` and
   * `GitHubSignInActions` are the sign-in, and the browser's docked bar presents
   * the same two, so neither surface can offer something the other does not.
   */

  /** The panel's own dock: this is the only surface that owns this placement. */
  const storageKey = `${APP_SLUG}.githubSignIn.v1`

  /** Whether the flow has stopped being something the user waits on. */
  const settled = $derived(!githubSignIn.waiting)

  const onScreen = $derived(githubSignIn.open && !githubSignIn.dockedInAppBrowser)

  const restoreLabel = $derived(`Show GitHub sign-in (${githubSignIn.statusLabel.toLowerCase()})`)

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
              {githubSignIn.statusLabel}
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

  <GitHubSignInBody />

  {#snippet footer()}
    <GitHubSignInActions />
  {/snippet}
</DockableModal>
