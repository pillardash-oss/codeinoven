<script lang="ts">
  import { Search, X } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    projectId: string
    projectName: string
    /** Whether the search dropdown is currently open. */
    open: boolean
    /** Current search query value. */
    query: string
    /** Called when the dropdown should open/close. */
    onOpenChange: (open: boolean) => void
    /** Called when the user types in the search input. */
    onQueryChange: (projectId: string, value: string) => void
  }

  let { projectId, projectName, open, query, onOpenChange, onQueryChange }: Props = $props()

  let searchInput: HTMLInputElement | undefined = $state(undefined)

  const focusSearchInput: Attachment<HTMLInputElement> = (element) => {
    searchInput = element
    element.focus()
  }
</script>

<Popover.Root {open} {onOpenChange}>
  <Popover.Trigger
    class="flex h-5 w-5 items-center justify-center rounded text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground"
    aria-label="Search threads in {projectName}"
    title="Search threads"
  >
    <Search size={12} />
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="right"
      align="start"
      sideOffset={8}
      collisionPadding={16}
      onInteractOutside={(e) => e.preventDefault()}
      class="z-50 w-80 overflow-hidden rounded-xl border bg-surface p-1.5 shadow-lg"
      aria-label="Search threads in {projectName}"
    >
      <div class="flex items-center gap-1.5">
        <Search size={14} class="shrink-0 text-dimmed" />
        <input
          {@attach focusSearchInput}
          type="text"
          class="h-7 min-w-0 flex-1 rounded-lg bg-app px-2 text-[11px] text-foreground outline-none placeholder:text-dimmed"
          placeholder="Search threads in {projectName}…"
          value={query}
          oninput={(e: Event) =>
            onQueryChange(projectId, (e.currentTarget as HTMLInputElement).value)}
        />
        {#if query}
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Clear search"
            title="Clear search"
            onclick={() => {
              onQueryChange(projectId, '')
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
