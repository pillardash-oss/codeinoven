<script lang="ts">
  import { Globe, Lock, LockOpen } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { resolveBrowserAddress } from '$shared/browser-search-engines'
  import type { GlobalBrowserTab } from '$lib/stores/global-browser-types'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { BROWSER_HISTORY_GLOBAL_SCOPE, browserHistory } from '$lib/stores/browser-history.svelte'
  import BrowserHistorySuggestions from './BrowserHistorySuggestions.svelte'

  interface Props {
    /** The address the spotlight opened on, selected and ready to replace. */
    initialValue: string
    boxId: GlobalBrowserTab['boxId']
    /** Open a resolved address: navigate the tab this was opened from, or make a
     *  new one when it has no page yet. */
    onOpen: (url: string) => void
    onClose: () => void
  }

  let { initialValue, boxId, onOpen, onClose }: Props = $props()

  /**
   * The browser view's address palette.
   *
   * This is the global browser's address bar, which is a control that opens the
   * app's own palette: the whole window is available to it, so the address is
   * replaced in a palette pre-filled with the page on screen and selected, with
   * the pages the user has already been to offered underneath. Those pages are the
   * selected profile box's history: when a thread and the global browser use the
   * same box, both offer the same visits. Unboxed thread history stays within its
   * conversation and is never offered here.
   *
   * The thread browser does not use this. Its address bar is the field itself and
   * brings the same history down in a drawer under it
   * (`BrowserAddressBar.svelte`), because a panel docked in a thread's sidebar has
   * no room for a palette and no reason for one.
   */

  /** How many history rows are offered. A palette is scanned, not read: the
   *  newest handful is what a person picks from. */
  const SUGGESTION_LIMIT = 7

  const listId = $props.id()

  // The field's own text is its own from the moment the panel opens: the address
  // on screen is only the seed, and the surface mounts a fresh panel per open, so
  // a later change to the prop must not overwrite what the user is typing.
  // svelte-ignore state_referenced_locally
  let value = $state(initialValue)
  let error = $state('')
  /** The highlighted history row, or -1 while the field's own text is what Enter
   *  would open. Typing clears it, so a query the user is mid-way through is never
   *  hijacked by a suggestion that merely matches it. */
  let highlight = $state(-1)
  /** The one field, focused and selected the moment the panel is up. Bound here
   *  rather than left to the shared "first text field" rule so the address is
   *  selected too, which is what the gesture promises: the address to replace, not
   *  just a caret at one end of it. */
  let addressInput = $state<HTMLInputElement | null>(null)

  const suggestions = $derived(
    browserHistory.suggestionsFor(
      browserHistory.scopeFor(BROWSER_HISTORY_GLOBAL_SCOPE, '', boxId),
      value,
      SUGGESTION_LIMIT
    )
  )
  const secure = $derived(initialValue.startsWith('https:'))

  function open(url: string): void {
    onOpen(url)
    onClose()
  }

  function submit(): void {
    const highlighted = suggestions[highlight]
    if (highlighted) {
      open(highlighted.url)
      return
    }
    const resolution = resolveBrowserAddress(value, appConfigState.browserSearchEngine)
    if (!resolution) {
      error = 'Enter a search or an address'
      return
    }
    open(resolution.url)
  }

  /** Move the highlight through the list. From nothing highlighted, either arrow
   *  enters the list, which is what makes the keys discoverable. */
  function moveHighlight(delta: 1 | -1): void {
    if (suggestions.length === 0) return
    const next = highlight + delta
    highlight = Math.min(suggestions.length - 1, Math.max(0, next))
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  }
</script>

<Modal
  open
  title="Open an address"
  description="Type the address to open, or pick a page you have already visited."
  placement="palette"
  size="lg"
  chrome={false}
  {onClose}
  contentClass="max-h-[min(26rem,65vh)] overflow-y-auto p-1.5"
  claimInitialFocus={() => {
    if (!addressInput) return false
    addressInput.focus()
    addressInput.select()
    return true
  }}
>
  <div class="flex items-center gap-2 rounded-lg bg-elevated px-3">
    {#if secure}
      <Lock size={13} class="shrink-0 text-success" />
    {:else if initialValue !== ''}
      <LockOpen size={13} class="shrink-0 text-dimmed" />
    {:else}
      <Globe size={15} class="shrink-0 text-dimmed" />
    {/if}
    <input
      bind:this={addressInput}
      type="text"
      class="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-dimmed"
      placeholder="Search or enter an address"
      aria-label="Address to open"
      aria-invalid={error !== ''}
      spellcheck="false"
      autocomplete="off"
      bind:value
      oninput={() => {
        // The field's own text is what Enter opens until the user reaches for a
        // suggestion, so a query being typed keeps its meaning.
        highlight = -1
        error = ''
      }}
      onkeydown={onKeydown}
    />
    {#if error}
      <span class="shrink-0 pr-1 text-[0.6875rem] text-danger">{error}</span>
    {:else}
      <span class="shrink-0 pr-1 text-[0.6875rem] text-dimmed">Enter to open</span>
    {/if}
  </div>

  {#if suggestions.length > 0}
    <div class="mt-1.5 border-t border-border pt-1.5">
      <BrowserHistorySuggestions
        {listId}
        {suggestions}
        {highlight}
        onHighlight={(index) => (highlight = index)}
        onOpen={(entry) => open(entry.url)}
      />
    </div>
  {/if}
</Modal>
