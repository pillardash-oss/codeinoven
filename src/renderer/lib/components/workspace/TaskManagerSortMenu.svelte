<script lang="ts">
  import CioArrowDown from '@pdslng/cio-icon/CioArrowDown.svelte'
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioArrowUpDown from '@pdslng/cio-icon/CioArrowUpDown.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import type { Attachment } from 'svelte/attachments'
  import {
    defaultDirectionFor,
    TASK_SORT_HINTS,
    TASK_SORT_KEYS,
    TASK_SORT_LABELS,
    type TaskSort,
    type TaskSortDirection,
    type TaskSortKey
  } from './task-manager-sort'

  /**
   * The task manager's sort control: one icon in the toolbar that opens the
   * ordering menu.
   *
   * The menu is drawn inside the panel rather than in a portal popup, the same
   * way the project picker beside it is. The task manager is a Modal the native
   * projection draws above the browser's page view, and a portaled popup forces
   * that modal onto the app-window presentation, which detaches the browser for
   * as long as the menu is open.
   *
   * Choosing a key adopts that key's natural direction (resources heaviest
   * first, text A to Z) unless it is the key already in use, so flipping a
   * direction and then re-reading the menu never resets the flip.
   */

  interface Props {
    sort: TaskSort
    onSortChange: (sort: TaskSort) => void
  }

  let { sort, onSortChange }: Props = $props()

  const DIRECTIONS: readonly TaskSortDirection[] = ['asc', 'desc']

  const DIRECTION_LABELS: Record<TaskSortDirection, string> = {
    asc: 'Ascending',
    desc: 'Descending'
  }

  let open = $state(false)
  let menuElement = $state<HTMLElement | null>(null)

  const triggerTitle = $derived(
    `Sort: ${TASK_SORT_LABELS[sort.key]}, ${sort.direction === 'asc' ? 'ascending' : 'descending'}`
  )

  function openMenu(): void {
    open = true
  }

  function closeMenu(): void {
    open = false
  }

  function toggleMenu(): void {
    if (open) closeMenu()
    else openMenu()
  }

  function selectKey(key: TaskSortKey): void {
    onSortChange({
      key,
      direction: key === sort.key ? sort.direction : defaultDirectionFor(key)
    })
  }

  function selectDirection(direction: TaskSortDirection): void {
    onSortChange({ key: sort.key, direction })
  }

  /** Every control in the menu, in reading order: keys first, then direction. */
  function menuButtons(): HTMLButtonElement[] {
    return menuElement ? [...menuElement.querySelectorAll<HTMLButtonElement>('button')] : []
  }

  function focusButton(index: number): void {
    const buttons = menuButtons()
    if (buttons.length === 0) return
    const next = (index + buttons.length) % buttons.length
    buttons[next]?.focus()
  }

  function currentIndex(event: KeyboardEvent): number {
    const target = event.currentTarget
    const buttons = menuButtons()
    return target instanceof HTMLButtonElement ? buttons.indexOf(target) : -1
  }

  /** The menu owns its keys while it is open, so its arrows never reach the
   *  list behind it and Escape closes the menu instead of the modal. */
  function handleMenuKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      event.stopPropagation()
      focusButton(currentIndex(event) + (event.key === 'ArrowDown' ? 1 : -1))
      return
    }
    if (event.key.startsWith('Arrow') || event.key === 'Home' || event.key === 'End')
      event.stopPropagation()
  }

  /** A press anywhere outside closes the menu, whether it lands in the panel or
   *  on the page behind it. */
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

  /** Opening is the moment to take focus: the key in use is where the user
   *  starts reading the menu. */
  const trackMenu: Attachment<HTMLElement> = (node) => {
    menuElement = node
    const active = node.querySelector<HTMLButtonElement>('button[data-active="true"]')
    active?.focus()
    return () => {
      menuElement = null
    }
  }
</script>

<div class="relative" {@attach trackOutsideClick}>
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center border transition-colors {open
      ? 'border-border bg-overlay text-foreground'
      : 'border-border bg-elevated text-dimmed hover:bg-overlay hover:text-foreground'}"
    aria-expanded={open}
    title={triggerTitle}
    aria-label={`${triggerTitle}. Choose how the list is ordered`}
    onclick={toggleMenu}
  >
    <CioArrowUpDown size={13} />
  </button>

  {#if open}
    <div
      {@attach trackMenu}
      role="group"
      aria-label="Sort running processes and services"
      class="absolute bottom-full end-0 z-10 mb-1 flex w-56 flex-col border border-border bg-surface p-1 shadow-lg"
    >
      {#each TASK_SORT_KEYS as key (key)}
        <button
          type="button"
          aria-pressed={sort.key === key}
          data-active={sort.key === key}
          title={TASK_SORT_HINTS[key]}
          class="flex items-center gap-2 px-2.5 py-2 text-left outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated"
          onkeydown={handleMenuKeydown}
          onclick={() => selectKey(key)}
        >
          <span
            class="min-w-0 flex-1 truncate text-xs {sort.key === key
              ? 'font-medium text-foreground'
              : 'text-muted'}">{TASK_SORT_LABELS[key]}</span
          >
          {#if sort.key === key}
            <CioCheck size={12} class="shrink-0 text-primary" />
          {/if}
        </button>
      {/each}

      <span aria-hidden="true" class="mx-1 my-1 border-t border-border"></span>

      <p class="px-2.5 pb-1 text-[0.625rem] uppercase tracking-wide text-dimmed">Direction</p>
      <div role="group" aria-label="Sort direction" class="flex gap-1 px-1 pb-1">
        {#each DIRECTIONS as direction (direction)}
          <button
            type="button"
            aria-pressed={sort.direction === direction}
            title={`Order ${DIRECTION_LABELS[direction].toLowerCase()}`}
            class="flex flex-1 items-center justify-center gap-1.5 border px-2 py-1.5 text-[0.6875rem] font-medium outline-none transition-colors {sort.direction ===
            direction
              ? 'border-primary bg-primary text-on-primary'
              : 'border-border bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            onkeydown={handleMenuKeydown}
            onclick={() => selectDirection(direction)}
          >
            {#if direction === 'asc'}
              <CioArrowUp size={11} />
            {:else}
              <CioArrowDown size={11} />
            {/if}
            {DIRECTION_LABELS[direction]}
          </button>
        {/each}
      </div>
    </div>
  {/if}
</div>
