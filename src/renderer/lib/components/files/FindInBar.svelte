<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import { ChevronDown, ChevronUp, X } from '@lucide/svelte'

  interface Props {
    query: string
    matches: number
    activeIndex: number
    placeholder?: string
    label?: string
    floating?: boolean
    focusTrigger?: number
    debounceMs?: number
    onQueryChange: (query: string) => void | Promise<void>
    onNext: () => void
    onPrev: () => void
    onClose: () => void
  }

  let {
    query,
    matches,
    activeIndex,
    placeholder = 'Find…',
    label = 'Find',
    floating = false,
    focusTrigger = 0,
    debounceMs = 180,
    onQueryChange,
    onNext,
    onPrev,
    onClose
  }: Props = $props()

  // Intentional local draft: the parent receives only settled queries.
  // svelte-ignore state_referenced_locally
  let draft = $state(query)
  let inputEl = $state<HTMLInputElement | null>(null)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let handledFocusTrigger = -1
  let previousFocus: HTMLElement | null = null

  function clearDebounce(): void {
    if (debounceTimer === null) return
    clearTimeout(debounceTimer)
    debounceTimer = null
  }

  function commitDraft(): void {
    clearDebounce()
    void onQueryChange(draft)
  }

  function scheduleQuery(value: string): void {
    draft = value
    clearDebounce()
    debounceTimer = setTimeout(commitDraft, debounceMs)
  }

  async function handleKeydown(event: KeyboardEvent): Promise<void> {
    if (event.key === 'Escape') {
      event.preventDefault()
      handleClose()
      return
    }
    if (event.key !== 'Enter') return

    event.preventDefault()
    if (draft !== query) {
      clearDebounce()
      await onQueryChange(draft)
      await tick()
    }
    if (event.shiftKey) onPrev()
    else onNext()
  }

  function handleClose(): void {
    clearDebounce()
    onClose()
    void tick().then(() => previousFocus?.focus())
  }

  $effect(() => {
    const trigger = focusTrigger
    if (!inputEl || handledFocusTrigger === trigger) return
    handledFocusTrigger = trigger
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== inputEl) previousFocus = active
    inputEl.focus()
    inputEl.select()
  })

  onDestroy(clearDebounce)
</script>

<div
  data-find-exclude
  class={[
    'flex h-10 shrink-0 items-center gap-1.5 rounded-xl border border-border bg-surface px-2 shadow-xl',
    floating ? 'absolute right-3 top-3 z-30 w-[min(26rem,calc(100%-1.5rem))]' : 'w-full'
  ]}
  role="search"
  aria-label={label}
>
  <input
    bind:this={inputEl}
    type="search"
    class="h-7 min-w-0 flex-1 rounded-lg border border-border bg-app px-2.5 text-xs text-foreground outline-none placeholder:text-dimmed focus:border-primary"
    {placeholder}
    value={draft}
    oninput={(event: Event & { currentTarget: HTMLInputElement }) =>
      scheduleQuery(event.currentTarget.value)}
    onkeydown={(event: KeyboardEvent) => void handleKeydown(event)}
  />
  {#if draft}
    <span class="whitespace-nowrap text-[10px] text-dimmed tabular-nums">
      {matches > 0 ? `${activeIndex + 1}/${matches}` : '0/0'}
    </span>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
      aria-label="Previous match"
      title="Previous match (Shift+Enter)"
      disabled={matches === 0}
      onclick={onPrev}
    >
      <ChevronUp size={13} aria-hidden="true" />
    </button>
    <button
      type="button"
      class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-30"
      aria-label="Next match"
      title="Next match (Enter)"
      disabled={matches === 0}
      onclick={onNext}
    >
      <ChevronDown size={13} aria-hidden="true" />
    </button>
  {/if}
  <button
    type="button"
    class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Close find"
    title="Close find (Escape)"
    onclick={handleClose}
  >
    <X size={13} aria-hidden="true" />
  </button>
</div>
