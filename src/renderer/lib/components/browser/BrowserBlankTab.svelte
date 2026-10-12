<script lang="ts">
  import { ArrowRight, Boxes, Globe } from '@lucide/svelte'
  import { resolveBrowserAddress } from '$shared/browser-search-engines'
  import type { BrowserHistoryEntry } from '$shared/browser/browser-library'
  import { publicAssetUrl } from '$lib/static-assets'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import { browserHistory } from '$lib/stores/browser-history.svelte'
  import {
    boxIdForJar,
    DEFAULT_BOX_ID,
    type GlobalBrowserBox
  } from '$lib/stores/global-browser-types'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import BrowserHistorySuggestions from './BrowserHistorySuggestions.svelte'
  import { browserAppearanceAccent, browserAppearanceIconUrl } from './browser-group-appearance'

  interface Props {
    /** Scope that owns the history offered under the field. */
    projectId: string
    threadId: string
    boxId: string | null
    /** Open a resolved address in this tab. */
    onNavigate: (url: string) => void
    /** Take the caret when the empty state appears. Off where the top bar owns focus. */
    autofocus?: boolean
    /** Label of the scope's own jar. When provided it is offered first as a pickable box. */
    scopeLabel?: string
    /** Reopen this blank tab in the chosen box. Null names the scope's own jar. */
    onSelectBox: (boxId: string | null) => void
  }

  let {
    projectId,
    threadId,
    boxId,
    onNavigate,
    autofocus = false,
    scopeLabel,
    onSelectBox
  }: Props = $props()

  /**
   * Blank tab empty state: the monochrome mark, what is missing, a field
   * that moves the tab to an address, and the boxes the tab can live in.
   *
   * The top chrome already carries an address field, so this one is a second
   * way in rather than the only one. It mirrors the top bar's own behavior:
   * typed text resolves to an address or a search, and history for the same
   * scope is offered underneath. The box row mirrors the toolbar's box
   * control: picking one reopens the blank tab in that jar.
   */

  const logoUrl = publicAssetUrl('icon-mono.svg')
  const listId = $props.id()

  let input = $state<HTMLInputElement | null>(null)
  let draft = $state('')
  let highlight = $state(-1)
  let touched = $state(false)

  const scope = $derived(browserHistory.scopeFor(projectId, threadId, boxId))
  const suggestions = $derived(browserHistory.suggestionsFor(scope, draft, 5))
  const drawerVisible = $derived(touched && draft.trim() !== '' && suggestions.length > 0)
  const activeOptionId = $derived(
    drawerVisible && highlight >= 0 ? `${listId}-option-${highlight}` : undefined
  )

  interface BoxOption {
    id: string | null
    name: string
    box: GlobalBrowserBox | null
  }

  /** The jars this tab can live in: the scope's own first, then every box. */
  const boxOptions = $derived.by((): BoxOption[] => {
    const options: BoxOption[] =
      scopeLabel === undefined ? [] : [{ id: null, name: scopeLabel, box: null }]
    for (const box of globalBrowser.boxes) options.push({ id: box.id, name: box.name, box })
    return options
  })
  /** The row shows only while there is a choice to make: a lone box is a fact, not a picker. */
  const showBoxes = $derived(globalBrowser.boxes.length > 1)
  /**
   * The jar the tab is in, named the way the options name it. A global tab
   * with no box runs in the default box's jar, so it matches the Default row.
   */
  const activeBoxId = $derived(scopeLabel === undefined ? boxIdForJar(boxId) : boxId)

  /** A box's own mark: its picked icon, a globe for the unstyled default, or a dot in its accent. */
  function boxIconUrl(box: GlobalBrowserBox): string | null {
    return browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
  }

  $effect(() => {
    if (autofocus) input?.focus()
  })

  function open(url: string): void {
    onNavigate(url)
  }

  function submit(): void {
    const picked = suggestions[highlight]
    if (picked) {
      open(picked.url)
      return
    }
    const resolution = resolveBrowserAddress(draft, appConfigState.browserSearchEngine)
    if (resolution) open(resolution.url)
  }

  function onInput(event: Event): void {
    const target = event.currentTarget
    if (!(target instanceof HTMLInputElement)) return
    draft = target.value
    highlight = -1
    touched = true
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!drawerVisible) return
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      highlight = Math.min(suggestions.length - 1, Math.max(0, highlight + delta))
      return
    }
    if (event.key === 'Escape') {
      highlight = -1
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    submit()
  }
</script>

<div
  class="flex h-full min-h-0 w-full flex-1 flex-col items-center justify-center px-6 py-8 text-center"
>
  <img src={logoUrl} alt="CodeInOven" class="mb-6 h-16 w-16 opacity-80" draggable="false" />
  <h2 class="text-[0.9375rem] font-semibold tracking-tight text-foreground">New tab</h2>
  <p class="mt-1 max-w-[42ch] text-[0.8125rem] leading-relaxed text-muted">
    This tab has no address yet. Type one below to start browsing.
  </p>
  <form
    class="relative mt-5 w-full max-w-md"
    onsubmit={(event) => {
      event.preventDefault()
      submit()
    }}
  >
    <div class="flex items-center gap-1.5 rounded-xl border border-border bg-elevated p-1.5 pl-3.5">
      <label for={listId} class="sr-only">Search or enter an address</label>
      <input
        id={listId}
        bind:this={input}
        type="text"
        role="combobox"
        class="h-8 min-w-0 flex-1 bg-transparent text-[0.8125rem] text-foreground outline-none placeholder:text-dimmed"
        placeholder="Search or enter an address"
        aria-label="Search or enter an address"
        aria-autocomplete="list"
        aria-expanded={drawerVisible}
        aria-controls={drawerVisible ? listId : undefined}
        aria-activedescendant={activeOptionId}
        spellcheck="false"
        autocomplete="off"
        value={draft}
        oninput={onInput}
        onkeydown={onKeydown}
      />
      <button
        type="submit"
        class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-40"
        disabled={draft.trim() === ''}
        aria-label="Open address"
        title="Open address"
      >
        <ArrowRight size={15} />
      </button>
    </div>
    {#if drawerVisible}
      <div
        class="absolute top-full right-0 left-0 z-20 mt-1.5 max-h-60 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 text-left shadow-lg"
      >
        <BrowserHistorySuggestions
          {listId}
          {suggestions}
          {highlight}
          onHighlight={(index) => (highlight = index)}
          onOpen={(entry: BrowserHistoryEntry) => open(entry.url)}
        />
      </div>
    {/if}
  </form>
  {#if showBoxes}
    <div
      class="mt-6 flex w-full max-w-md flex-wrap items-start justify-center gap-1"
      role="group"
      aria-label="Choose a box for this tab"
    >
      {#each boxOptions as option (option.id ?? 'scope')}
        {@const active = option.id === activeBoxId}
        {@const iconUrl = option.box ? boxIconUrl(option.box) : null}
        <button
          type="button"
          class={[
            'flex w-20 shrink-0 flex-col items-center gap-1 rounded-xl px-2 py-2.5 outline-none transition-colors hover:bg-elevated focus-visible:bg-elevated',
            active ? 'bg-elevated' : ''
          ]}
          aria-label={active ? `${option.name}, current box` : `Reopen this tab in ${option.name}`}
          aria-pressed={active}
          title={active ? `${option.name}, current box` : `Reopen this tab in ${option.name}`}
          onclick={() => onSelectBox(option.id)}
        >
          <span class="flex h-8 w-8 items-center justify-center" aria-hidden="true">
            {#if iconUrl}
              <img src={iconUrl} alt="" class="h-6 w-6 rounded-md object-contain" />
            {:else if option.box?.id === DEFAULT_BOX_ID}
              <Globe size={20} class="text-dimmed" />
            {:else if option.box}
              <span
                class="h-2.5 w-2.5 rounded-full"
                style:background-color={browserAppearanceAccent(option.box)}
              ></span>
            {:else}
              <Boxes size={20} class="text-dimmed" />
            {/if}
          </span>
          <span class="w-full truncate text-center text-[0.6875rem] font-medium text-foreground">
            {option.name}
          </span>
          <span class="flex h-4 items-center">
            {#if active}
              <StatusPill tone="success">Active</StatusPill>
            {/if}
          </span>
        </button>
      {/each}
    </div>
  {/if}
</div>
