<script lang="ts">
  import { Check, ChevronDown, ListFilter, Search } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Snippet } from 'svelte'
  import type { MultiSelectOption } from './multi-select-option'

  interface Props {
    options: readonly MultiSelectOption[]
    /** Selected option ids; an empty array means every option ("all"). */
    selectedIds: readonly string[]
    onSelectionChange: (ids: string[]) => void
    /** Trigger caption when nothing is selected. */
    allLabel?: string
    /** Compact trigger sizing for tight footers / toolbars. */
    compact?: boolean
    class?: string
    align?: 'start' | 'center' | 'end'
    side?: 'top' | 'bottom' | 'left' | 'right'
    sideOffset?: number
    ariaLabel?: string
    searchPlaceholder?: string
    emptyMessage?: string
    disabled?: boolean
    /** Custom trigger; receives the currently selected options. */
    trigger?: Snippet<[MultiSelectOption[]]>
  }

  let {
    options,
    selectedIds,
    onSelectionChange,
    allLabel = 'All',
    compact = false,
    class: className = '',
    align = 'end',
    side = 'bottom',
    sideOffset = 6,
    ariaLabel = 'Filter',
    searchPlaceholder = 'Search…',
    emptyMessage = 'No matching options',
    disabled = false,
    trigger
  }: Props = $props()

  let search = $state('')

  let selectedIdSet = $derived(new Set(selectedIds))
  let selectedOptions = $derived(options.filter((option) => selectedIdSet.has(option.id)))
  let filteredOptions = $derived(
    options.filter((option) =>
      [option.label, option.description].some((value) =>
        value?.toLowerCase().includes(search.trim().toLowerCase())
      )
    )
  )

  function toggle(optionId: string): void {
    onSelectionChange(
      selectedIdSet.has(optionId)
        ? selectedIds.filter((candidate) => candidate !== optionId)
        : [...selectedIds, optionId]
    )
  }

  /** An option icon that fails to decode simply disappears; the label carries
   *  the row either way. */
  function hideBrokenIcon(event: Event): void {
    if (event.currentTarget instanceof HTMLImageElement) {
      event.currentTarget.style.visibility = 'hidden'
    }
  }
</script>

<DropdownMenu.Root
  onOpenChange={(open) => {
    if (open) search = ''
  }}
>
  <DropdownMenu.Trigger
    class={trigger
      ? `flex items-center justify-center rounded transition-colors hover:bg-elevated focus:outline-none ${className}`
      : compact
        ? `flex h-7 items-center gap-1.5 rounded-md border border-border bg-elevated px-2 text-left text-[0.625rem] font-medium text-dimmed outline-none transition-colors hover:bg-overlay hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`
        : `flex w-full items-center gap-2 rounded-lg border bg-elevated px-3 text-left text-sm outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    aria-label={ariaLabel}
    title={ariaLabel}
    {disabled}
  >
    {#if trigger}
      {@render trigger(selectedOptions)}
    {:else}
      <span class="flex -space-x-1.5" aria-hidden="true">
        {#each selectedOptions.slice(0, 3) as option (option.id)}
          <span
            class="flex h-5 w-5 items-center justify-center overflow-hidden rounded border bg-raised text-dimmed"
            style:border-color={option.color}
          >
            {#if option.iconUrl}
              <img
                src={option.iconUrl}
                alt=""
                class="h-3.5 w-3.5 object-contain"
                onerror={hideBrokenIcon}
              />
            {:else if option.icon}
              {@const Icon = option.icon}
              <Icon size={11} />
            {:else}
              <span
                class="h-2 w-2 rounded-full"
                style:background-color={option.color ?? 'currentColor'}
              ></span>
            {/if}
          </span>
        {/each}
        {#if selectedOptions.length === 0}
          <span
            class="flex h-5 w-5 items-center justify-center rounded border bg-raised text-dimmed"
          >
            <ListFilter size={11} />
          </span>
        {/if}
      </span>
      <span class="min-w-0 flex-1 truncate">
        {selectedOptions.length === 0 ? allLabel : `${selectedOptions.length} selected`}
      </span>
      <ChevronDown size={compact ? 12 : 14} class="shrink-0 text-dimmed" />
    {/if}
  </DropdownMenu.Trigger>

  <DropdownMenu.Portal>
    <DropdownMenu.Content
      {side}
      {align}
      {sideOffset}
      class="z-60 min-w-64 rounded-xl border border-border bg-surface p-1 shadow-lg"
    >
      <div class="relative mx-1 mb-1 mt-0.5">
        <input
          type="text"
          placeholder={searchPlaceholder}
          bind:value={search}
          class="w-full rounded-md border border-border bg-elevated py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-dimmed focus:outline-none"
          onclick={(event: MouseEvent) => event.stopPropagation()}
          onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
        />
        <Search
          size={12}
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dimmed"
        />
      </div>

      <DropdownMenu.Item
        class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
        textValue={allLabel}
        onSelect={(event) => {
          event.preventDefault()
          onSelectionChange([])
        }}
      >
        <span class="min-w-0 flex-1 truncate text-xs font-medium">{allLabel}</span>
        {#if selectedIds.length === 0}
          <Check size={12} class="shrink-0 text-primary" />
        {/if}
      </DropdownMenu.Item>
      <div class="mx-1 my-1 border-t border-border" aria-hidden="true"></div>

      {#each filteredOptions as option (option.id)}
        <DropdownMenu.Item
          class="flex items-center gap-2 rounded-md px-2.5 py-2 outline-none transition-colors data-[highlighted]:bg-elevated"
          textValue={option.label}
          title={option.description ?? option.label}
          onSelect={(event) => {
            event.preventDefault()
            toggle(option.id)
          }}
        >
          {#if option.color}
            <span
              class="w-0.5 shrink-0 self-stretch rounded-full"
              style:background-color={option.color}
            ></span>
          {/if}
          {#if option.iconUrl}
            <img
              src={option.iconUrl}
              alt=""
              class="h-4 w-4 shrink-0 rounded object-contain"
              onerror={hideBrokenIcon}
            />
          {:else if option.icon}
            {@const Icon = option.icon}
            <span class="flex h-4 w-4 shrink-0 items-center justify-center text-dimmed">
              <Icon size={14} />
            </span>
          {/if}
          <span class="flex min-w-0 flex-1 flex-col">
            <span
              class="truncate text-xs {selectedIdSet.has(option.id)
                ? 'font-medium text-foreground'
                : 'text-muted'}">{option.label}</span
            >
            {#if option.description}
              <span class="truncate text-[0.6875rem] text-dimmed">{option.description}</span>
            {/if}
          </span>
          {#if selectedIdSet.has(option.id)}
            <Check size={12} class="shrink-0 text-primary" />
          {/if}
        </DropdownMenu.Item>
      {/each}

      {#if filteredOptions.length === 0}
        <p class="px-3 py-5 text-center text-xs text-dimmed">{emptyMessage}</p>
      {/if}
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
