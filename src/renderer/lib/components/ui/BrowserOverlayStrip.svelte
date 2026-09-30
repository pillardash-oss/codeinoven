<script lang="ts">
  import {
    ArrowLeft,
    ArrowRight,
    Check,
    Globe,
    Loader2,
    Lock,
    LockOpen,
    Moon,
    Pin,
    Puzzle,
    RotateCw,
    Star,
    Volume2,
    VolumeX,
    X
  } from '@lucide/svelte'
  import {
    TOAST_OVERLAY_TOP,
    type BrowserStripOverlayAction,
    type BrowserStripOverlayRequest
  } from '$shared/browser-overlay'

  interface Props {
    /** The strip on display, exactly as the app renderer projected it. */
    strip: BrowserStripOverlayRequest
    /** Show this tab's page. */
    onSelect: (tabId: string) => void
    /** Close this tab. */
    onClose: (tabId: string) => void
    /** Run a chrome control. `x`/`y` are this document's own coordinates, which
     *  the site-settings popup is anchored from. */
    onAction: (action: BrowserStripOverlayAction, x: number, y: number) => void
  }

  let { strip, onSelect, onClose, onAction }: Props = $props()

  /**
   * The browser's floating sidebar, drawn in the overlay window over a page.
   *
   * It is the hover reveal the collapsed sidebar gives, at the same width and in
   * the same place: the address row and its controls above, then the tabs the way
   * the docked strip lists them. Only what the docked panel needs a second mount
   * for   group headers, the search field, per-tab menus and drag reordering  
   * is left in the docked panel; the rows and the controls a user reaches for
   * while the page is live are all here.
   *
   * The panel's own geometry is the app layout's, not this document's: the window
   * starts at the application header's bottom edge, and the panel's viewport top
   * follows the user's font size, so its top inside this document is the
   * difference between the two.
   */
  const top = $derived(strip.top - TOAST_OVERLAY_TOP)
  const chrome = $derived(strip.chrome)

  /** A control that opens a native popup hands over the point under itself, in
   *  this document's own space; the app renderer translates it to its window. */
  function actionAt(action: BrowserStripOverlayAction, event: MouseEvent): void {
    const button = event.currentTarget
    if (!(button instanceof HTMLElement)) {
      onAction(action, 0, 0)
      return
    }
    const rect = button.getBoundingClientRect()
    onAction(action, rect.left, rect.bottom + 4)
  }
</script>

<aside
  class="absolute bottom-0 left-0 flex flex-col overflow-hidden bg-surface shadow-2xl"
  style:top="{top}px"
  style:width="{strip.width}px"
  data-overlay-strip
  aria-label="Browser tabs"
>
  <!-- The address row: the same controls the docked panel's chrome carries. -->
  <div class="shrink-0 border-b px-2 py-2">
    <div class="mb-1.5 flex items-center gap-1">
      {#if chrome.canGoBack}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Go back in page history"
          title="Go back"
          onclick={(event: MouseEvent) => actionAt('back', event)}
        >
          <ArrowLeft size={15} />
        </button>
      {/if}
      {#if chrome.canGoForward}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label="Go forward in page history"
          title="Go forward"
          onclick={(event: MouseEvent) => actionAt('forward', event)}
        >
          <ArrowRight size={15} />
        </button>
      {/if}
      {#if chrome.loading || chrome.url !== ''}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={chrome.loading ? 'Stop loading' : 'Reload page'}
          title={chrome.loading ? 'Stop loading' : 'Reload page'}
          onclick={(event: MouseEvent) => actionAt(chrome.loading ? 'stop' : 'reload', event)}
        >
          {#if chrome.loading}
            <X size={15} />
          {:else}
            <RotateCw size={14} />
          {/if}
        </button>
      {/if}
      <div class="flex min-w-0 flex-1 items-center gap-1 rounded-lg bg-elevated pr-0.5 pl-1.5">
        {#if chrome.url}
          <button
            type="button"
            class={[
              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay',
              chrome.secure ? 'text-success' : 'text-dimmed'
            ]}
            title={chrome.secure ? 'Site settings' : 'Connection is not secure'}
            aria-label={chrome.secure ? 'Site settings' : 'Connection is not secure'}
            aria-haspopup="menu"
            onclick={(event: MouseEvent) => actionAt('open-site-menu', event)}
          >
            {#if chrome.secure}
              <Lock size={12} />
            {:else}
              <LockOpen size={12} />
            {/if}
          </button>
        {:else}
          <Globe size={12} class="shrink-0 text-dimmed" />
        {/if}
        <button
          type="button"
          class={[
            'h-7 min-w-0 flex-1 truncate text-left text-xs',
            chrome.url === '' ? 'text-dimmed' : 'text-foreground'
          ]}
          title="Search or enter an address"
          aria-label="Search or enter an address"
          onclick={(event: MouseEvent) => actionAt('open-address', event)}
        >
          {chrome.url === '' ? 'Search or enter an address' : chrome.url}
        </button>
        {#if chrome.storeOffer}
          <button
            type="button"
            class={[
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay disabled:opacity-60',
              chrome.storeOffer.installed ? 'text-success' : 'text-primary'
            ]}
            disabled={chrome.storeOffer.installing && !chrome.storeOffer.installed}
            title={chrome.storeOffer.title}
            aria-label={chrome.storeOffer.title}
            onclick={(event: MouseEvent) => actionAt('act-on-store-offer', event)}
          >
            {#if chrome.storeOffer.installing && !chrome.storeOffer.installed}
              <Loader2 size={12} class="animate-spin" />
            {:else if chrome.storeOffer.installed}
              <Check size={12} />
            {:else}
              <Puzzle size={12} />
            {/if}
          </button>
        {/if}
        <button
          type="button"
          class={[
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-overlay',
            chrome.bookmarked ? 'text-warning' : 'text-dimmed hover:text-foreground'
          ]}
          disabled={chrome.url === ''}
          aria-label={chrome.bookmarked ? 'Remove this page from bookmarks' : 'Bookmark this page'}
          aria-pressed={chrome.bookmarked}
          title={chrome.bookmarked ? 'Remove bookmark' : 'Bookmark this page'}
          onclick={(event: MouseEvent) => actionAt('toggle-bookmark', event)}
        >
          <Star size={12} class={chrome.bookmarked ? 'fill-current' : ''} />
        </button>
      </div>
    </div>
  </div>

  <ul class="min-h-0 flex-1 overflow-y-auto px-2 py-2" role="list">
    {#each strip.tabs as tab (tab.id)}
      <li
        class="group flex items-center rounded-md {tab.active
          ? 'bg-elevated'
          : 'hover:bg-elevated'}"
      >
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left"
          title={tab.url || tab.label}
          aria-label={`Show ${tab.label}`}
          aria-current={tab.active ? 'page' : undefined}
          onclick={() => onSelect(tab.id)}
          onauxclick={(event: MouseEvent) => {
            // Middle click closes, exactly as a docked row does.
            if (event.button === 1) onClose(tab.id)
          }}
        >
          <span class="flex h-4 w-4 shrink-0 items-center justify-center">
            {#if tab.loading}
              <Loader2 size={13} class="animate-spin text-muted" />
            {:else if tab.icon}
              <img src={tab.icon} alt="" class="h-4 w-4 rounded-sm object-contain" />
            {:else}
              <Globe size={12} class="text-dimmed" />
            {/if}
          </span>
          <span
            class="min-w-0 flex-1 truncate text-xs {tab.hibernated
              ? 'text-dimmed'
              : 'text-foreground'} {tab.active ? 'font-medium' : ''}"
            style={tab.accent ? `color: ${tab.accent}` : undefined}>{tab.label}</span
          >
          {#if tab.pinned}
            <span class="shrink-0 text-accent" role="img" title="Pinned tab">
              <Pin size={12} />
            </span>
          {/if}
          {#if tab.muted}
            <span class="shrink-0 text-accent" role="img" title="Tab is muted">
              <VolumeX size={12} />
            </span>
          {:else if tab.audible}
            <span class="shrink-0 text-accent" role="img" title="Tab is playing audio">
              <Volume2 size={12} />
            </span>
          {:else if tab.hibernated}
            <span class="shrink-0 text-dimmed" role="img" title="Hibernated to save memory">
              <Moon size={12} />
            </span>
          {/if}
        </button>
        <button
          type="button"
          class="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground"
          aria-label={`Close ${tab.label}`}
          title={`Close ${tab.label}`}
          onclick={() => onClose(tab.id)}
        >
          <X size={12} />
        </button>
      </li>
    {/each}
    {#if strip.tabs.length === 0}
      <li class="px-2 py-1.5 text-xs text-dimmed">No tabs are open.</li>
    {/if}
  </ul>
</aside>
