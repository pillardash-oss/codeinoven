<script lang="ts">
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import Modal from '../ui/Modal.svelte'
  import DeferredMarkdownView from '../markdown/DeferredMarkdownView.svelte'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import { keymapState } from '$lib/keymap/keymap-state.svelte'
  import type { PromptReference } from '$shared/types'

  interface Props {
    /** The excerpt a sent message carries: the passage the user marked and the
     *  comment they wrote on it. */
    reference: PromptReference
    onClose: () => void
  }

  let { reference, onClose }: Props = $props()

  /** The exact words of a passage that came straight from a file, as opposed to
   *  an element picked from a page or an artifact, which reads as a description
   *  rather than as text to read. */
  const literal = $derived(reference.kind === undefined || reference.kind === 'selection')
</script>

<!-- The reader for a passage a message carries: the same full screen lightbox a
     text attachment opens in, because a marked passage is that attachment's
     cousin — material the user handed the agent, worth reading back later
     instead of hunting for a truncated chip and its tooltip. The passage is drawn
     with the markdown the conversation rendered it from, and the comment sits
     beneath it, where the words the user wrote about it belong. -->
<Modal
  open
  title={`Passage from ${reference.label}`}
  {onClose}
  placement="fullscreen"
  chrome={false}
  panelClass="bg-overlay/80 backdrop-blur-sm"
  claimInitialFocus={(panel) => {
    panel.querySelector<HTMLElement>('button')?.focus()
    return true
  }}
>
  <div
    class="titlebar-drag flex h-12 shrink-0 items-center gap-2 border-b border-border pr-3"
    style={trafficLightInsetStyle()}
  >
    <CioMessage size={12} class="shrink-0 text-accent" />
    <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">
      {reference.label}
    </span>
    <button
      type="button"
      class="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Close passage reader"
      title="Close passage reader (Esc)"
      onclick={onClose}
    >
      <CioMinimize size={14} />
    </button>
  </div>
  <div
    role="presentation"
    class="relative flex min-h-0 flex-1 items-center justify-center"
    onclick={onClose}
    onkeydown={(e: KeyboardEvent) => {
      if (e.target === e.currentTarget && keymapState.matches('ui-activate', e)) onClose()
    }}
  >
    <div
      role="presentation"
      class="flex h-full min-h-0 w-full items-start justify-center p-4"
      onclick={(e: MouseEvent) => e.stopPropagation()}
    >
      <article
        class="flex max-h-full min-h-0 w-full max-w-3xl flex-col overflow-auto bg-surface p-5 shadow-2xl"
      >
        <p
          class="flex items-center gap-1.5 text-[0.625rem] font-semibold tracking-[0.06em] uppercase text-dimmed"
        >
          <CioMessage size={10} class="shrink-0" />
          Selected passage
        </p>
        {#if literal}
          <DeferredMarkdownView text={reference.text} class="mt-2 text-sm text-foreground" />
        {:else}
          <p class="mt-2 text-sm whitespace-pre-wrap break-words text-foreground">
            {reference.text}
          </p>
        {/if}
        {#if reference.comment}
          <div class="mt-5 border-t border-border pt-4">
            <p
              class="flex items-center gap-1.5 text-[0.625rem] font-semibold tracking-[0.06em] uppercase text-dimmed"
            >
              <CioPencil size={10} class="shrink-0" />
              Your comment
            </p>
            <p class="mt-2 text-sm whitespace-pre-wrap break-words text-foreground">
              {reference.comment}
            </p>
          </div>
        {/if}
      </article>
    </div>
  </div>
</Modal>
