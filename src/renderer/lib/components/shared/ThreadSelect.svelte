<script lang="ts">
  import { ChevronDown, FolderKanban, Search } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { ScopeProject } from '$lib/stores/scope.svelte'
  import ThreadRow from '$lib/components/threads/ThreadRow.svelte'
  import { isOrchestrationChildThread, type Thread } from '$shared/types'

  interface Props {
    threads: readonly Thread[]
    project?: ScopeProject | null
    value?: string | null
    onValueChange: (threadId: string) => void
    ariaLabel: string
    placeholder?: string
    searchPlaceholder?: string
    emptyMessage?: string
    disabled?: boolean
    class?: string
    align?: 'start' | 'center' | 'end'
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    trigger?: Snippet<[Thread | null]>
  }

  let {
    threads,
    project = null,
    value = null,
    onValueChange,
    ariaLabel,
    placeholder = 'Select a thread',
    searchPlaceholder = 'Search threads…',
    emptyMessage = 'No matching threads',
    disabled = false,
    class: className = '',
    align = 'start',
    side = 'bottom',
    sideOffset = 6,
    trigger
  }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let selectedThread = $derived(threads.find((thread) => thread.id === value) ?? null)
  let filteredThreads = $derived.by(() => {
    const normalized = query.trim().toLowerCase()
    return threads
      .filter((thread) => !thread.archived && !isOrchestrationChildThread(thread))
      .filter(
        (thread) =>
          !normalized ||
          thread.title.toLowerCase().includes(normalized) ||
          thread.branch?.toLowerCase().includes(normalized)
      )
  })

  function selectThread(threadId: string): void {
    if (!threadId || threadId === value) return
    onValueChange(threadId)
  }
</script>

<DropdownMenu.Root
  bind:open
  onOpenChange={(nextOpen) => {
    if (nextOpen) query = ''
  }}
>
  <DropdownMenu.Trigger
    class={trigger
      ? `flex items-center justify-center rounded transition-colors hover:bg-elevated focus:outline-none ${className}`
      : `flex h-9 w-full items-center gap-2 rounded-lg border bg-elevated px-3 text-left text-sm outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    aria-label={ariaLabel}
    title={ariaLabel}
    {disabled}
  >
    {#if trigger}
      {@render trigger(selectedThread)}
    {:else}
      <span
        class="flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-raised text-dimmed"
        style:border-color={project?.color}
        aria-hidden="true"
      >
        {#if project?.iconUrl}
          <img src={project.iconUrl} alt="" class="h-4 w-4 object-contain" />
        {:else}
          <FolderKanban size={13} />
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate {selectedThread ? 'text-foreground' : 'text-dimmed'}">
        {selectedThread?.title ?? placeholder}
      </span>
      <ChevronDown size={14} class="shrink-0 text-dimmed" />
    {/if}
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {side}
      {align}
      {sideOffset}
      collisionPadding={16}
      class="z-60 min-w-72 overflow-hidden rounded-xl border bg-surface shadow-lg"
    >
      <div class="relative border-b p-2">
        <Search
          size={13}
          class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <input
          class="h-8 w-full rounded-lg bg-elevated pl-8 pr-3 text-xs text-foreground outline-none placeholder:text-dimmed"
          placeholder={searchPlaceholder}
          bind:value={query}
          onclick={(event: MouseEvent) => event.stopPropagation()}
          onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
        />
      </div>

      <div class="max-h-72 overflow-y-auto p-1" role="list">
        {#each filteredThreads as thread (thread.id)}
          <DropdownMenu.Item
            class="overflow-hidden rounded-lg p-0 outline-none data-[highlighted]:bg-elevated"
            textValue={thread.title}
            onSelect={() => selectThread(thread.id)}
          >
            <ThreadRow
              {thread}
              picker
              selected={value === thread.id}
              projectIconUrl={project?.iconUrl}
            />
          </DropdownMenu.Item>
        {/each}
        {#if filteredThreads.length === 0}
          <p class="px-3 py-6 text-center text-xs text-dimmed">{emptyMessage}</p>
        {/if}
      </div>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
