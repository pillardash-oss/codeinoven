<script lang="ts">
  import CioClose from '$lib/components/icons/cio/CioClose.svelte'
  import CioSearch from '$lib/components/icons/cio/CioSearch.svelte'
  import { Popover } from 'bits-ui'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    /** Whether the search popover is currently open. */
    open: boolean
    /** Current search query value. */
    query: string
    /** Called when the search should open/close (Escape, re-click, close button). */
    onOpenChange: (open: boolean) => void
    /** Called when the user types in the search input. */
    onQueryChange: (value: string) => void
    /** Accessible label for the trigger button and popover. */
    ariaLabel: string
    /** Tooltip shown on the trigger button. */
    title: string
    /** Placeholder text inside the search input. */
    placeholder: string
    /** Trigger size   'sm' for dense rows, 'md' for sidebar header toolbars. */
    size?: 'sm' | 'md'
  }

  let {
    open,
    query,
    onOpenChange,
    onQueryChange,
    ariaLabel,
    title,
    placeholder,
    size = 'sm'
  }: Props = $props()

  const triggerClass = $derived(
    size === 'md'
      ? 'flex h-7 w-7 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground'
      : 'flex h-5 w-5 items-center justify-center text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground'
  )

  const focusSearchInput: Attachment<HTMLInputElement> = (element) => {
    element.focus()
  }
</script>

<Popover.Root {open} {onOpenChange}>
  <Popover.Trigger class={triggerClass} aria-label={ariaLabel} {title}>
    <CioSearch size={size === 'md' ? 15 : 12} strokeWidth={size === 'md' ? 1.8 : undefined} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="right"
      align="start"
      sideOffset={8}
      collisionPadding={16}
      onInteractOutside={(e) => e.preventDefault()}
      class="z-50 w-80 overflow-hidden border bg-surface p-1.5 shadow-lg"
      aria-label={ariaLabel}
    >
      <div class="flex items-center gap-1.5">
        <CioSearch size={14} class="shrink-0 text-dimmed" />
        <input
          {@attach focusSearchInput}
          type="text"
          class="h-7 min-w-0 flex-1 bg-app px-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
          {placeholder}
          value={query}
          oninput={(e: Event) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
        />
        <!-- One control, one meaning: the X dismisses the whole search. It used
             to be two X's side by side ("clear" and "close"), so clicking the
             left one emptied the query, wiped the sidebar results and left the
             panel open - a dismiss that only looked like one. Dismissal already
             clears the query and its results. -->
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Dismiss search"
          title="Dismiss search"
          onclick={() => onOpenChange(false)}
        >
          <CioClose size={13} />
        </button>
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
