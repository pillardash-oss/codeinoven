<script lang="ts">
  import { Toaster as Sonner } from 'svelte-sonner'
  import { CheckCircle2, AlertTriangle, XCircle, Info } from '@lucide/svelte'

  /**
   * The app's toaster, configured once.
   *
   * Two windows draw this stack: the app window, and the native overlay that
   * covers a browser page (`BrowserOverlaySurface.svelte`). They have to be the
   * same toaster to the pixel, or a toast would visibly jump when the stack
   * hands over between them, so the configuration lives here rather than being
   * written out twice. The cards' own look is `toaster.css`, which the app's
   * stylesheet pulls in for both windows.
   */
  interface Props {
    /** The palette the cards are drawn in. */
    theme: 'light' | 'dark'
    /** Distance from the top of this document to the first card, in pixels. The
     *  overlay's document starts above the app's content, so the two differ. */
    offsetTop: number
  }

  let { theme, offsetTop }: Props = $props()
</script>

{#snippet successIcon()}
  <CheckCircle2 size={15} stroke-width={2.25} />
{/snippet}

{#snippet warningIcon()}
  <AlertTriangle size={15} stroke-width={2.25} />
{/snippet}

{#snippet errorIcon()}
  <XCircle size={15} stroke-width={2.25} />
{/snippet}

{#snippet infoIcon()}
  <Info size={15} stroke-width={2.25} />
{/snippet}

<Sonner
  position="top-right"
  {theme}
  closeButton
  pauseWhenPageIsHidden
  offset={{ top: `${offsetTop}px` }}
  {successIcon}
  {warningIcon}
  {errorIcon}
  {infoIcon}
  toastOptions={{
    classes: {
      toast: 'group toast shadow-lg rounded-lg font-[inherit]',
      title: 'text-[0.8125rem] font-semibold tracking-tight',
      description: 'group-[.toast]:text-muted text-xs',
      actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-on-primary',
      cancelButton: 'group-[.toast]:bg-elevated group-[.toast]:text-muted'
    }
  }}
/>
