<script lang="ts">
  import CioLock from 'cio-icon/CioLock.svelte'
  import CioLockOpen from 'cio-icon/CioLockOpen.svelte'
  import CioSpinner from 'cio-icon/CioSpinner.svelte'
  import type { Attachment } from 'svelte/attachments'
  import { resolveBrowserAddress } from '$shared/browser-search-engines'
  import type { BrowserHistoryEntry } from '$shared/browser/browser-library'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { browserHistory } from '$lib/stores/browser-history.svelte'
  import { browserBlankDraft } from '$lib/stores/browser-blank-draft.svelte'
  import { trackBrowserOcclusion } from '$lib/stores/browser-visibility.svelte'
  import BrowserHistorySuggestions from './BrowserHistorySuggestions.svelte'

  interface Props {
    /** The address of the page on screen, which the field mirrors until the user
     *  types over it. */
    url: string
    /** Tab that owns this field. Keys the shared blank draft so typing that
     *  started in the empty state continues here with the same caret. */
    tabId?: string | null
    /** The surface this field's tab belongs to, which is what decides whose
     *  history is offered under it. */
    projectId: string
    threadId: string
    boxId: string | null
    /** Whether the page on screen is served over https. */
    secure: boolean
    /** Whether the page is loading. */
    loading: boolean
    /** Whether the site-settings popup is up, which the padlock reports. */
    siteMenuOpen: boolean
    /** Open the native site-settings menu under the padlock. */
    onOpenSiteMenu: (event: MouseEvent) => void
    /** Open an address in this panel's tab. */
    onNavigate: (url: string) => void
  }

  let {
    url,
    tabId = null,
    projectId,
    threadId,
    boxId,
    secure,
    loading,
    siteMenuOpen,
    onOpenSiteMenu,
    onNavigate
  }: Props = $props()

  /**
   * The thread browser's address bar.
   *
   * The browser view's bar is a control that opens the app's address palette
   * (`BrowserAddressSpotlight`), because that view has the whole window to offer
   * a palette in. A browser docked in a thread's sidebar does not: this bar is
   * the field itself. The caret lands where the user clicked, the address is
   * typed in place, and typing brings the pages already visited down under the
   * field, matched to what has been typed by the same ranking the palette uses.
   *
   * The field mirrors the page's own address until it is typed in (`draft`), so a
   * page-state report   a title, a finished load, a redirect   can never
   * overwrite text the user is mid-way through. Leaving the field drops the draft,
   * so the bar can never show an address the tab is not on.
   *
   * The drawer offers pages from this browser's unboxed scope, or from its selected
   * box when it uses a shared profile. Box history follows the box across the
   * global and thread browsers; unboxed conversation history lasts for the session
   * and disappears with the last tab.
   *
   * The drawer is a floating DOM overlay over the page, and the page is a native
   * view composed above every DOM surface, so the drawer publishes its own
   * rectangle and the visibility store detaches the page for as long as it is up
   * (`trackBrowserOcclusion`). Nothing here has to know that happened.
   */

  /** How many history rows are offered. A drawer is scanned, not read. */
  const SUGGESTION_LIMIT = 7

  const listId = $props.id()

  let input = $state<HTMLInputElement | undefined>(undefined)
  /** The field's own element, captured as an attachment: the drawer's keyboard
   *  handling, the Escape that leaves the field and the new tab's focus gesture
   *  all address the element directly. */
  const attachInput: Attachment<HTMLInputElement> = (element) => {
    input = element
    return () => {
      if (input === element) input = undefined
    }
  }
  /** What the user has typed, or null while the field still mirrors the page's
   *  own address. A blank tab starts from the shared empty-state draft so
   *  opening fullscreen mid-typing continues seamlessly. */
  // svelte-ignore state_referenced_locally
  let draft = $state<string | null>(
    url === '' && tabId ? (browserBlankDraft.get(tabId)?.text ?? null) : null
  )
  /** The highlighted history row, or -1 while the typed text is what Enter opens. */
  let highlight = $state(-1)
  /** Whether the drawer has been asked for. It comes up with the first keystroke
   *  rather than with the click, so reading the address never covers the page. */
  let drawerOpen = $state(false)

  const value = $derived(draft ?? url)
  const scope = $derived(browserHistory.scopeFor(projectId, threadId, boxId))
  const suggestions = $derived(browserHistory.suggestionsFor(scope, value, SUGGESTION_LIMIT))
  /** Whether the drawer is actually on screen, which is when the field may claim
   *  it is expanded and point the screen reader at a highlighted row. */
  const drawerVisible = $derived(drawerOpen && suggestions.length > 0)
  /**
   * The field's horizontal padding: the padlock's slot on the left whenever there
   * is an address, and a wider right inset while a load is in flight so the
   * address stops short of the load indicator instead of running under it.
   */
  const fieldPadding = $derived(`${url === '' ? 'pl-2' : 'pl-8'} ${loading ? 'pr-8' : 'pr-2'}`)
  const activeOptionId = $derived(
    drawerVisible && highlight >= 0 ? `${listId}-option-${highlight}` : undefined
  )

  /**
   * Take the keyboard with the whole address selected. This is the new tab's
   * gesture and the address shortcut's: the address on screen is what the user is
   * about to replace, so it is selected rather than left as a caret to place.
   */
  export function focusAndSelect(): void {
    close()
    input?.focus()
    input?.select()
  }

  /**
   * Take the keyboard with the caret at `offset` (or the stored blank offset
   * when omitted). This is the fullscreen continuation: the text the user was
   * typing stays, and typing resumes exactly where it stopped.
   */
  export function focusWithCaret(offset?: number | null): void {
    const element = input
    if (!element) return
    element.focus()
    const fallback =
      offset ??
      (tabId && url === ''
        ? (browserBlankDraft.get(tabId)?.caret ?? element.value.length)
        : element.value.length)
    try {
      element.setSelectionRange(fallback, fallback)
    } catch {
      // Focus alone is the fallback.
    }
  }

  /** Drop the draft and the drawer: the field goes back to being the page's own
   *  address. A blank tab keeps its shared draft, so leaving the field never
   *  discards text the fullscreen surface must continue. */
  function close(): void {
    if (tabId && url === '') {
      const stored = browserBlankDraft.get(tabId)?.text
      if (stored) {
        draft = stored
        highlight = -1
        drawerOpen = false
        return
      }
    }
    draft = null
    highlight = -1
    drawerOpen = false
  }

  /** Handle blur without dropping a blank continuation. */
  function onBlur(): void {
    highlight = -1
    drawerOpen = false
    if (tabId && url === '' && draft !== null && draft !== '') {
      return
    }
    if (!(tabId && url === '' && browserBlankDraft.get(tabId))) {
      draft = null
    }
  }

  function open(target: string): void {
    if (tabId) browserBlankDraft.clear(tabId)
    close()
    onNavigate(target)
  }

  function submit(): void {
    const picked = suggestions[highlight]
    if (picked) {
      open(picked.url)
      return
    }
    const resolution = resolveBrowserAddress(value, appConfigState.browserSearchEngine)
    if (resolution) open(resolution.url)
  }

  function onInput(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement)) return
    draft = target.value
    // Typing clears the highlight, so a query the user is mid-way through is
    // never hijacked by a suggestion that merely matches it.
    highlight = -1
    drawerOpen = true
    // Mirror blank-tab typing into the shared draft so the empty-state field
    // and the other surface's bar show the same continuation.
    if (tabId && url === '') {
      browserBlankDraft.set(tabId, draft, target.selectionStart ?? draft.length)
    }
  }

  /** Caret-only moves keep the shared caret exact for the handoff. */
  function onCaretMove(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement)) return
    if (!tabId || url !== '' || draft === null || draft === '') return
    browserBlankDraft.set(tabId, draft, target.selectionStart ?? draft.length)
  }

  /** Move the highlight through the list. From nothing highlighted, either arrow
   *  enters the list, which is what makes the keys discoverable. */
  function moveHighlight(delta: 1 | -1): void {
    if (suggestions.length === 0) return
    highlight = Math.min(suggestions.length - 1, Math.max(0, highlight + delta))
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!drawerVisible) return
      event.preventDefault()
      moveHighlight(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      // The first Escape puts the page's own address back; a second one leaves the
      // field, which is the order the gesture reads in.
      if (drawerVisible) {
        close()
        return
      }
      input?.blur()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  }
</script>

<div class="relative min-w-0 flex-1">
  <span class="sr-only">Browser address</span>
  {#if url !== ''}
    <button
      type="button"
      class="absolute left-1.5 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title={secure ? 'Site settings' : 'Connection is not secure'}
      aria-label={secure ? 'Site settings' : 'Connection is not secure'}
      aria-haspopup="menu"
      aria-expanded={siteMenuOpen}
      onclick={onOpenSiteMenu}
    >
      {#if secure}
        <CioLock size={13} />
      {:else}
        <CioLockOpen size={13} />
      {/if}
    </button>
  {/if}
  <input
    {@attach attachInput}
    type="text"
    role="combobox"
    class={[
      'h-7 w-full border border-border bg-elevated text-xs text-foreground outline-none transition-colors placeholder:text-dimmed',
      fieldPadding
    ]}
    placeholder="Search or enter an address"
    aria-label="Search or enter an address"
    aria-autocomplete="list"
    aria-expanded={drawerVisible}
    aria-controls={drawerVisible ? listId : undefined}
    aria-activedescendant={activeOptionId}
    spellcheck="false"
    autocomplete="off"
    {value}
    oninput={onInput}
    onkeyup={onCaretMove}
    onclick={onCaretMove}
    onselect={onCaretMove}
    onkeydown={onKeydown}
    onblur={onBlur}
  />
  <!--
    The load indicator is filled, not just drawn: it sits over the end of the
    field, so a transparent one lets the address show through the gaps in the
    spinner and the two read as one smudged line. The fill is the field's own
    background, inset by the border, so it covers the address without covering
    the field's edge.
  -->
  {#if loading}
    <span
      role="img"
      class="pointer-events-none absolute inset-y-px right-px flex w-7 items-center justify-center bg-elevated"
      title="Loading page"
      aria-label="Loading page"
    >
      <CioSpinner size={13} class="animate-spin text-primary" />
    </span>
  {/if}
  {#if drawerVisible}
    <div
      {@attach trackBrowserOcclusion}
      class="absolute top-full right-0 left-0 z-20 mt-1 max-h-[min(16rem,50vh)] overflow-y-auto border border-border bg-surface p-1.5 shadow-lg"
    >
      <BrowserHistorySuggestions
        {listId}
        {suggestions}
        {highlight}
        compact
        onHighlight={(index) => (highlight = index)}
        onOpen={(entry: BrowserHistoryEntry) => open(entry.url)}
      />
    </div>
  {/if}
</div>
