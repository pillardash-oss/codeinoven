<script lang="ts">
  import { Search, X } from '@lucide/svelte'
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
    /** Trigger size — 'sm' for dense rows, 'md' for sidebar header toolbars. */
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

  let searchInput: HTMLInputElement | undefined = $state(undefined)

  const triggerClass = $derived(
    size === 'md'
      ? 'flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground'
      : 'flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground'
  )

  const focusSearchInput: Attachment<HTMLInputElement> = (element) => {
    searchInput = element
    element.focus()
  }
</script>

<Popover.Root {open} {onOpenChange}>
  <Popover.Trigger class={triggerClass} aria-label={ariaLabel} {title}>
    <Search size={size === 'md' ? 14 : 12} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="right"
      align="start"
      sideOffset={8}
      collisionPadding={16}
      onInteractOutside={(e) => e.preventDefault()}
      class="z-50 w-80 overflow-hidden rounded-xl border bg-surface p-1.5 shadow-lg"
      aria-label={ariaLabel}
    >
      <div class="flex items-center gap-1.5">
        <Search size={14} class="shrink-0 text-dimmed" />
        <input
          {@attach focusSearchInput}
          type="text"
          class="h-7 min-w-0 flex-1 rounded-lg bg-app px-2 text-[0.6875rem] text-foreground outline-none placeholder:text-dimmed"
          {placeholder}
          value={query}
          oninput={(e: Event) => onQueryChange((e.currentTarget as HTMLInputElement).value)}
        />
        {#if query}
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
            onclick={() => {
              onQueryChange('')
              searchInput?.focus()
            }}
          >
            <X size={13} />
          </button>
        {/if}
        <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
        <Popover.Close
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Close search"
          title="Close search"
        >
          <X size={13} />
        </Popover.Close>
      </div>
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
