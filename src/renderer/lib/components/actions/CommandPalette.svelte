<script lang="ts">
  import { Command, Dialog } from 'bits-ui'
  import { CornerDownLeft, Search, X } from '@lucide/svelte'
  import { tick } from 'svelte'
  import { filterActions } from '../../actions'
  import type { ActionDefinition, ActionSelection } from '../../actions'

  interface Props {
    open: boolean
    actions: readonly ActionDefinition[]
    onSelect: (selection: ActionSelection) => void | Promise<void>
    onClose: () => void
    /** Restores an explicitly captured focus target. Return true to suppress dialog fallback. */
    onRestoreFocus?: () => boolean
    mode?: 'dialog' | 'inline'
    title?: string
    placeholder?: string
    emptyLabel?: string
    initialQuery?: string
    maxResults?: number
    closeOnSelect?: boolean
    shortcutLabel?: string
    onQueryChange?: (query: string) => void
  }

  let {
    open,
    actions,
    onSelect,
    onClose,
    onRestoreFocus,
    mode = 'dialog',
    title = 'Commands',
    placeholder = 'Search actions…',
    emptyLabel = 'No matching actions',
    initialQuery = '',
    maxResults = 60,
    closeOnSelect = true,
    shortcutLabel,
    onQueryChange
  }: Props = $props()

  let query = $state('')
  let selectedActionId = $state('')
  let inputElement = $state<HTMLInputElement | null>(null)
  let selectionMethod: ActionSelection['method'] = 'keyboard'
  let wasOpen = false

  let visibleActions = $derived(filterActions(actions, query, { limit: maxResults }))

  $effect(() => {
    if (open && !wasOpen) {
      wasOpen = true
      query = initialQuery
      selectedActionId = ''
      if (mode === 'inline') void tick().then(() => inputElement?.focus())
    } else if (!open) {
      wasOpen = false
    }
  })

  async function selectAction(action: ActionDefinition): Promise<void> {
    if (action.disabledReason) return

    const method = selectionMethod
    selectionMethod = 'keyboard'
    if (closeOnSelect) onClose()
    await onSelect({ action, query: query.trim(), method })
  }

  function handleInlineKeydown(event: KeyboardEvent): void {
    if (!open || mode !== 'inline' || event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onClose()
  }

  function categoryLabel(action: ActionDefinition): string {
    return action.category === 'mcp' ? 'MCP' : action.category
  }
</script>

<svelte:window onkeydown={handleInlineKeydown} />

{#snippet paletteBody()}
  <Command.Root
    class="overflow-hidden rounded-xl bg-surface"
    label={title}
    shouldFilter={false}
    loop
    value={selectedActionId}
    onValueChange={(value) => {
      selectedActionId = value
    }}
  >
    <header class="flex h-11 items-center gap-2 border-b border-border px-3">
      <Search size={15} class="shrink-0 text-dimmed" aria-hidden="true" />
      <Command.Input
        bind:ref={inputElement}
        bind:value={query}
        oninput={(event) => onQueryChange?.(event.currentTarget.value)}
        class="h-full min-w-0 flex-1 border-0 bg-transparent text-sm text-foreground outline-none ring-0 placeholder:text-dimmed focus:border-0 focus:outline-none focus:ring-0 focus-visible:outline-none!"
        {placeholder}
        aria-label={title}
        autocomplete="off"
        spellcheck="false"
      />
      {#if query}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Clear action search"
          title="Clear action search"
          onclick={() => {
            query = ''
            selectedActionId = ''
            onQueryChange?.('')
            inputElement?.focus()
          }}
        >
          <X size={14} aria-hidden="true" />
        </button>
      {/if}
      {#if mode === 'dialog'}
        <span class="flex items-center gap-1 border-l border-border pl-2">
          {#if shortcutLabel}
            <kbd
              class="rounded-md border border-border-strong bg-raised px-1.5 py-0.5 font-sans text-[10px] font-medium text-dimmed"
            >
              {shortcutLabel}
            </kbd>
          {/if}
          <span class="text-[10px] font-medium text-dimmed">ESC</span>
        </span>
      {/if}
    </header>

    <Command.List
      class="max-h-[min(24rem,55vh)] overflow-y-auto p-1.5"
      aria-label="{title} results"
    >
      {#each visibleActions as action (action.id)}
        <Command.Item
          value={action.id}
          disabled={Boolean(action.disabledReason)}
          class={[
            'group flex min-h-11 w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left outline-none transition-colors',
            action.disabledReason
              ? 'cursor-not-allowed opacity-50'
              : selectedActionId === action.id
                ? 'bg-overlay text-foreground'
                : 'text-muted hover:bg-elevated hover:text-foreground'
          ]}
          aria-label={action.disabledReason
            ? `${action.title}: ${action.disabledReason}`
            : action.title}
          title={action.disabledReason ?? action.description ?? action.title}
          onpointerdown={() => {
            if (!action.disabledReason) selectionMethod = 'pointer'
          }}
          onSelect={() => void selectAction(action)}
        >
          <span
            class={[
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border text-[9px] font-bold uppercase tracking-wide',
              selectedActionId === action.id && !action.disabledReason
                ? 'border-border-strong bg-surface text-foreground'
                : 'border-border bg-raised text-dimmed'
            ]}
            aria-hidden="true"
          >
            {categoryLabel(action).slice(0, 2)}
          </span>

          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-medium">{action.title}</span>
              <span
                class="shrink-0 rounded-md border border-border bg-raised px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-dimmed"
              >
                {categoryLabel(action)}
              </span>
              <span
                class="min-w-0 truncate rounded-md border border-border px-1.5 py-0.5 text-[9px] font-medium text-dimmed"
              >
                {action.source.label}
              </span>
            </span>
            {#if action.disabledReason}
              <span class="mt-0.5 block truncate text-[11px] text-danger">
                {action.disabledReason}
              </span>
            {:else if action.description}
              <span class="mt-0.5 block truncate text-[11px] text-dimmed">
                {action.description}
              </span>
            {/if}
          </span>

          {#if action.shortcut?.length}
            <span
              class="flex shrink-0 items-center gap-1"
              aria-label="Shortcut {action.shortcut.join(' ')}"
            >
              {#each action.shortcut as key (key)}
                <kbd
                  class="min-w-5 rounded-md border border-border-strong bg-raised px-1 py-0.5 text-center font-sans text-[10px] font-medium text-dimmed"
                >
                  {key}
                </kbd>
              {/each}
            </span>
          {:else if selectedActionId === action.id && !action.disabledReason}
            <CornerDownLeft size={14} class="shrink-0 text-dimmed" aria-hidden="true" />
          {/if}
        </Command.Item>
      {:else}
        <div class="flex min-h-28 items-center justify-center px-4 text-center">
          <p class="text-xs text-dimmed">{emptyLabel}</p>
        </div>
      {/each}
    </Command.List>

    <footer
      class="flex h-8 items-center justify-between border-t border-border bg-raised px-3 text-[10px] text-dimmed"
    >
      <span class="tabular-nums">{visibleActions.length} actions</span>
      <span>↑↓ Navigate · Enter Run</span>
    </footer>
  </Command.Root>
{/snippet}

{#if mode === 'dialog'}
  <Dialog.Root
    {open}
    onOpenChange={(nextOpen) => {
      if (!nextOpen) onClose()
    }}
  >
    <Dialog.Portal>
      <Dialog.Overlay class="fixed inset-0 z-40 bg-app/50" />
      <Dialog.Content
        class="fixed left-1/2 top-[18%] z-50 w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-xl"
        onCloseAutoFocus={(event) => {
          if (onRestoreFocus?.()) event.preventDefault()
        }}
      >
        <Dialog.Title class="sr-only">{title}</Dialog.Title>
        {@render paletteBody()}
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
{:else if open}
  <section
    class="absolute inset-x-0 bottom-full z-40 mb-2 overflow-hidden rounded-xl border border-border bg-surface shadow-xl"
    aria-label={title}
  >
    {@render paletteBody()}
  </section>
{/if}
