<script lang="ts">
  import CioCheck from '@codeinoven/icons/CioCheck.svelte'
  import CioChevronDown from '@codeinoven/icons/CioChevronDown.svelte'
  import CioFilter from '@codeinoven/icons/CioFilter.svelte'
  import CioSearch from '@codeinoven/icons/CioSearch.svelte'
  import { tick } from 'svelte'
  import type { Attachment } from 'svelte/attachments'
  import type { MultiSelectOption } from './multi-select-option'

  /**
   * One entity-agnostic filter list: a project, assistant, browser group, or task
   * sort picked from the same rows.
   *
   * The list is anchored to its trigger and opens inside the owning panel,
   * rather than in a portal popup. The spotlight and the task manager are Modals
   * that the native projection draws above the browser's page view, and that
   * projection refuses any panel containing an `aria-haspopup` element (a popup
   * it cannot own). A portaled `bits-ui` DropdownMenu therefore forced the whole
   * modal onto the app-window DOM presentation, which detaches the browser so
   * the panel can be seen. In-panel markup carries the same menu with no popup,
   * so the modal keeps its projection and the browser stays up.
   *
   * `single` turns the same rows into a single-choice picker: one row replaces
   * the selection instead of adding to it, and the trigger shows that row's
   * label. The in-panel menu is unchanged, so a projecting modal carries it the
   * same way.
   */
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
    ariaLabel?: string
    searchPlaceholder?: string
    emptyMessage?: string
    disabled?: boolean
    /** Single-choice mode: picking a row replaces the selection rather than
     *  adding to it, and the trigger shows that row's label. */
    single?: boolean
  }

  let {
    options,
    selectedIds,
    onSelectionChange,
    allLabel = 'All',
    compact = false,
    class: className = '',
    ariaLabel = 'Filter',
    searchPlaceholder = 'Search…',
    emptyMessage = 'No matching options',
    disabled = false,
    single = false
  }: Props = $props()

  let open = $state(false)
  let search = $state('')
  let menuElement = $state<HTMLElement | null>(null)

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
    if (single) {
      onSelectionChange(selectedIdSet.has(optionId) ? [] : [optionId])
      return
    }
    onSelectionChange(
      selectedIdSet.has(optionId)
        ? selectedIds.filter((candidate) => candidate !== optionId)
        : [...selectedIds, optionId]
    )
  }

  function openMenu(): void {
    open = true
    search = ''
  }

  function closeMenu(): void {
    open = false
  }

  function toggleMenu(): void {
    if (disabled) return
    if (open) closeMenu()
    else openMenu()
  }

  /** Every option is a button; the search field is the only other control. */
  function optionButtons(): HTMLButtonElement[] {
    return menuElement ? [...menuElement.querySelectorAll<HTMLButtonElement>('li button')] : []
  }

  function focusOption(index: number): void {
    const buttons = optionButtons()
    if (buttons.length === 0) return
    const next = (index + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  function currentIndex(event: KeyboardEvent): number {
    const target = event.currentTarget
    const buttons = optionButtons()
    return target instanceof HTMLButtonElement ? buttons.indexOf(target) : -1
  }

  /**
   * The menu owns its keys while open: Escape closes it, the arrow keys walk its
   * own options, and neither falls through to the palette's list navigation.
   */
  function handleOptionKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      focusOption(currentIndex(event) + (event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')
      event.stopPropagation()
  }

  /** Down from the search field steps into the list; up steps into its last row. */
  function handleSearchKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      focusOption(event.key === 'ArrowDown' ? 0 : -1)
      return
    }
    event.stopPropagation()
  }

  /**
   * A press anywhere else closes the menu, whether it lands in the panel or the
   * page behind it. Overlay clicks arrive as a real click on the source element,
   * so one document listener covers both presentations. Scoped to the mounted
   * picker so nothing listens while it is closed.
   */
  const trackOutsideClick: Attachment<HTMLElement> = (node) => {
    function onClick(event: MouseEvent): void {
      if (!open) return
      const target = event.target
      if (target instanceof Node && node.contains(target)) return
      closeMenu()
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }

  /**
   * Keep the menu inside the panel: the panel clips its overflow, so a menu
   * taller than the room above the footer would lose its top edge. Measure that
   * room against the panel and cap the menu to it; the list scrolls instead. The
   * panel's own DOM is the ruler, so it sizes correctly in both the app window
   * and the native projection.
   */
  function fitMenu(menu: HTMLElement): void {
    const panel = menu.closest('[role="dialog"]')
    const anchor = menu.parentElement
    if (!panel || !anchor) return
    const room = anchor.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12
    menu.style.height = 'auto'
    const content = menu.scrollHeight
    menu.style.height = `${Math.max(96, Math.min(content, room))}px`
  }

  /** The list changes height as the query filters it, so re-fit it then too. */
  function refitMenu(): void {
    void tick().then(() => {
      if (menuElement) fitMenu(menuElement)
    })
  }

  /** The list exists only while open, so mounting it is the moment to take the
   *  caret, and to size it to the room between the footer and the panel top. */
  const trackMenu: Attachment<HTMLElement> = (node) => {
    menuElement = node
    node.querySelector<HTMLInputElement>('input')?.focus()
    fitMenu(node)
    return () => {
      menuElement = null
    }
  }

  /** An option icon that fails to decode simply disappears; the label carries
   *  the row either way. */
  function hideBrokenIcon(event: Event): void {
    if (event.currentTarget instanceof HTMLImageElement) {
      event.currentTarget.style.visibility = 'hidden'
    }
  }
</script>

<div {@attach trackOutsideClick} class="relative">
  <button
    type="button"
    class={compact
      ? `flex h-7 items-center gap-1.5 border border-border bg-elevated px-2 text-left text-[0.625rem] font-medium text-dimmed outline-none transition-colors hover:bg-overlay hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`
      : `flex w-full items-center gap-2 border bg-elevated px-3 text-left text-sm outline-none transition-colors hover:bg-overlay focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    aria-label={ariaLabel}
    title={ariaLabel}
    aria-expanded={open}
    {disabled}
    onclick={toggleMenu}
  >
    <span class="flex -space-x-1.5" aria-hidden="true">
      {#each selectedOptions.slice(0, 3) as option (option.id)}
        <span
          class="flex h-5 w-5 items-center justify-center overflow-hidden border bg-raised text-dimmed"
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
            <span class="h-2 w-2" style:background-color={option.color ?? 'currentColor'}></span>
          {/if}
        </span>
      {/each}
      {#if selectedOptions.length === 0}
        <span class="flex h-5 w-5 items-center justify-center border bg-raised text-dimmed">
          <CioFilter size={11} />
        </span>
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate">
      {selectedOptions.length === 0
        ? allLabel
        : single
          ? (selectedOptions[0]?.label ?? allLabel)
          : `${selectedOptions.length} selected`}
    </span>
    <CioChevronDown size={compact ? 12 : 14} class="shrink-0 text-dimmed" />
  </button>

  {#if open}
    <div
      {@attach trackMenu}
      class="absolute bottom-full end-0 z-10 mb-1 flex min-w-64 flex-col overflow-hidden border border-border bg-surface p-1 shadow-lg"
    >
      <div class="relative mx-1 mb-1 mt-0.5 shrink-0">
        <input
          type="text"
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          bind:value={search}
          class="w-full border border-border bg-elevated py-1.5 pl-7 pr-2 text-xs text-foreground placeholder:text-dimmed focus:outline-none"
          oninput={refitMenu}
          onkeydown={handleSearchKeydown}
        />
        <CioSearch
          size={12}
          class="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-dimmed"
        />
      </div>

      <ul class="min-h-0 flex-1 overflow-y-auto">
        <li>
          <button
            type="button"
            aria-pressed={selectedIds.length === 0}
            class="flex w-full items-center gap-2 px-2.5 py-2 text-left outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated"
            onkeydown={handleOptionKeydown}
            onclick={() => onSelectionChange([])}
          >
            <span class="min-w-0 flex-1 truncate text-xs font-medium">{allLabel}</span>
            {#if selectedIds.length === 0}
              <CioCheck size={12} class="shrink-0 text-primary" />
            {/if}
          </button>
        </li>
        <li aria-hidden="true" class="mx-1 my-1 border-t border-border"></li>

        {#each filteredOptions as option (option.id)}
          <li>
            <button
              type="button"
              aria-pressed={selectedIdSet.has(option.id)}
              title={option.description ?? option.label}
              class="flex w-full items-center gap-2 px-2.5 py-2 text-left outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated"
              onkeydown={handleOptionKeydown}
              onclick={() => toggle(option.id)}
            >
              {#if option.color}
                <span class="w-0.5 shrink-0 self-stretch" style:background-color={option.color}
                ></span>
              {/if}
              {#if option.iconUrl}
                <img
                  src={option.iconUrl}
                  alt=""
                  class="h-4 w-4 shrink-0 object-contain"
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
                <CioCheck size={12} class="shrink-0 text-primary" />
              {/if}
            </button>
          </li>
        {/each}
      </ul>

      {#if filteredOptions.length === 0}
        <p class="shrink-0 px-3 py-5 text-center text-xs text-dimmed">{emptyMessage}</p>
      {/if}
    </div>
  {/if}
</div>
