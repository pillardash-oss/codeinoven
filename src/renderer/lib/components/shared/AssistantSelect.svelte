<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import { DropdownMenu } from 'bits-ui'
  import { AssistantDefaultIcon, getAssistantIcon } from '$lib/assistant-icons'
  import type { Assistant } from '$shared/types'

  interface Props {
    /** Every assistant a memory can be pinned to, in the sidebar's own order. */
    assistants: readonly Assistant[]
    /** Stored custom icon data URLs, keyed by assistant id. */
    iconUrls?: ReadonlyMap<string, string>
    value?: string | null
    onValueChange: (assistantId: string) => void
    ariaLabel: string
    placeholder?: string
    searchPlaceholder?: string
    emptyMessage?: string
    disabled?: boolean
    class?: string
    align?: 'start' | 'center' | 'end'
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
  }

  let {
    assistants,
    iconUrls,
    value = null,
    onValueChange,
    ariaLabel,
    placeholder = 'Select an assistant',
    searchPlaceholder = 'Search assistants…',
    emptyMessage = 'No matching assistants',
    disabled = false,
    class: className = '',
    align = 'start',
    side = 'bottom',
    sideOffset = 6
  }: Props = $props()

  let open = $state(false)
  let query = $state('')
  let selected = $derived(assistants.find((assistant) => assistant.id === value) ?? null)
  let searchTerm = $derived(query.trim().toLowerCase())
  let filteredAssistants = $derived(
    searchTerm
      ? assistants.filter((assistant) => assistant.name.toLowerCase().includes(searchTerm))
      : assistants
  )

  /** The assistant's own mark, falling back to the app's assistant icon rather
   *  than to the name, which is often a whole sentence. */
  function iconFor(assistant: Assistant): string | null {
    return getAssistantIcon(assistant, iconUrls?.get(assistant.id) ?? null)
  }

  function select(assistantId: string): void {
    if (assistantId === value) return
    onValueChange(assistantId)
  }
</script>

<DropdownMenu.Root
  bind:open
  onOpenChange={(nextOpen) => {
    if (nextOpen) query = ''
  }}
>
  <DropdownMenu.Trigger
    class="flex h-9 w-full items-center gap-2 border bg-elevated px-3 text-left text-sm outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 {className}"
    aria-label={ariaLabel}
    title={ariaLabel}
    {disabled}
  >
    {#if selected}
      {@const selectedIcon = iconFor(selected)}
      {#if selectedIcon}
        <img src={selectedIcon} alt="" class="h-4 w-4 shrink-0 object-contain" />
      {:else}
        <AssistantDefaultIcon size={16} class="shrink-0 text-muted" />
      {/if}
      <span class="min-w-0 flex-1 truncate text-foreground">{selected.name}</span>
    {:else}
      <span class="min-w-0 flex-1 truncate text-dimmed">{placeholder}</span>
    {/if}
    <CioChevronDown size={14} class="shrink-0 text-dimmed" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {side}
      {align}
      {sideOffset}
      class="z-60 min-w-64 border border-border bg-surface p-1 shadow-lg"
    >
      <div class="relative mx-1 mb-1 mt-0.5">
        <input
          type="text"
          placeholder={searchPlaceholder}
          bind:value={query}
          class="w-full border border-border bg-elevated py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-dimmed focus:outline-none"
          onclick={(event: MouseEvent) => event.stopPropagation()}
          onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
        />
        <CioSearch
          size={12}
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dimmed"
        />
      </div>

      {#each filteredAssistants as assistant (assistant.id)}
        {@const icon = iconFor(assistant)}
        <DropdownMenu.Item
          class="flex items-center gap-2 px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={assistant.name}
          title={assistant.name}
          onSelect={() => select(assistant.id)}
        >
          {#if icon}
            <img src={icon} alt="" class="h-4 w-4 shrink-0 object-contain" />
          {:else}
            <AssistantDefaultIcon size={16} class="shrink-0 text-muted" />
          {/if}
          <span class="min-w-0 flex-1 truncate text-xs font-medium">{assistant.name}</span>
          {#if assistant.id === value}
            <CioCheck size={12} class="shrink-0 text-primary" />
          {/if}
        </DropdownMenu.Item>
      {/each}

      {#if filteredAssistants.length === 0}
        <p class="px-3 py-5 text-center text-xs text-dimmed">{emptyMessage}</p>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
