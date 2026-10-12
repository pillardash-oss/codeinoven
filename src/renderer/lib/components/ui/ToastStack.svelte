<script lang="ts">
  import { Toaster as Sonner } from 'svelte-sonner'
  import { CheckCircle2, AlertTriangle, XCircle, Info } from '@lucide/svelte'

  /**
   * The app's toaster, configured once.
   *
   * Only NativeToastSurface mounts the cards. The app renderer owns the toast
   * state and callbacks, while one bounded native view draws this stack.
   * The shared stylesheet supplies the card appearance and motion.
   */
  interface Props {
    /** The palette the cards are drawn in. */
    theme: 'light' | 'dark'
    /** Distance from the top of the native document to the first card. */
    offsetTop: number
    native?: boolean
  }

  let { theme, offsetTop, native = false }: Props = $props()
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
  mobileOffset={native ? { top: `${offsetTop}px`, right: '24px', left: '32px' } : undefined}
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
