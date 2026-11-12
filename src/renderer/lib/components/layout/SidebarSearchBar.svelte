<script lang="ts">
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { encodeShortcutTokens } from '$lib/keymap/keymap'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    /** Whether the field is open. The button is the closed state of the field. */
    open: boolean
    query: string
    placeholder: string
    ariaLabel: string
    loading?: boolean
    onOpenChange: (open: boolean) => void
    onQueryChange: (value: string) => void
    /**
     * Text drawn beside the mark on the closed button. It truncates as the row
     * narrows and gives way to the mark alone at the narrowest width, so the
     * control is never a squeezed word.
     */
    label?: string
    /** Symbolic key tokens of the chord that opens this search. */
    shortcut?: readonly string[]
  }

  let {
    open,
    query,
    placeholder,
    ariaLabel,
    loading = false,
    onOpenChange,
    onQueryChange,
    label = undefined,
    shortcut = []
  }: Props = $props()

  // The field takes the focus the moment it exists: the user asked for the
  // search, so their next keystroke belongs in it.
  const focusField: Attachment<HTMLInputElement> = (element) => {
    element.focus()
  }

  let button: HTMLButtonElement | undefined = $state(undefined)

  /** The chevron gives the row back to the button the search came from, so the
   *  pointer lands where the search was rather than nowhere. */
  function collapse(): void {
    onOpenChange(false)
    button?.focus()
  }
</script>

{#if open}
  <div class="panel-search-layer flex h-7 min-w-0 flex-1 items-center gap-1.5">
    <div class="flex h-7 min-w-0 flex-1 items-center gap-1.5 border bg-app px-1.5">
      <CioSearch size={ICON_SIZE.inline} class="shrink-0 text-dimmed" />
      <input
        {@attach focusField}
        type="text"
        class="h-6 min-w-0 flex-1 bg-transparent text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
        {placeholder}
        aria-label={ariaLabel}
        value={query}
        oninput={(event) => onQueryChange(event.currentTarget.value)}
        onkeydown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          collapse()
        }}
      />
      {#if loading}
        <span
          class="flex h-5 w-5 shrink-0 items-center justify-center text-dimmed"
          role="status"
          aria-label="Searching"
        >
          <CioSpinner size={12} class="animate-spin" />
        </span>
      {/if}
    </div>
    <button
      type="button"
      class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Hide search"
      title="Hide search"
      onclick={collapse}
    >
      <!-- The registry has no left chevron: the down mark turned on its side is
           the same glyph, aimed back at the button the field came from. -->
      <CioChevronDown size={ICON_SIZE.inline} class="rotate-90" />
    </button>
  </div>
{:else}
  <button
    bind:this={button}
    type="button"
    class="flex h-7 min-w-0 items-center justify-center gap-1.5 px-2 text-muted transition-colors hover:bg-elevated hover:text-foreground"
    aria-label={ariaLabel}
    title={ariaLabel}
    data-shortcut={encodeShortcutTokens(shortcut)}
    onclick={() => onOpenChange(true)}
  >
    <CioSearch size={ICON_SIZE.row} class="shrink-0" />
    {#if label}
      <span
        class="hidden truncate text-[0.6875rem] font-medium whitespace-nowrap @min-[13rem]:inline"
        >{label}</span
      >
    {/if}
  </button>
{/if}

<style>
  /* The field slides out of the button's place, so the two states read as one
     control changing shape. A plain CSS animation: the row is never measured and
     the swap must not wait on an outgoing layer. */
  .panel-search-layer {
    animation: panel-search-in 140ms cubic-bezier(0.22, 1, 0.36, 1) both;
  }

  @keyframes panel-search-in {
    from {
      opacity: 0.35;
      transform: translateX(-6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .panel-search-layer {
      animation: none;
    }
  }
</style>
