<script lang="ts">
  import { Globe, Loader2, Moon, Pin, Volume2, VolumeX, X } from '@lucide/svelte'
  import { TOAST_OVERLAY_TOP, type BrowserStripOverlayRequest } from '$shared/browser-overlay'

  interface Props {
    /** The strip on display, exactly as the app renderer projected it. */
    strip: BrowserStripOverlayRequest
    /** Show this tab's page. */
    onSelect: (tabId: string) => void
    /** Close this tab. */
    onClose: (tabId: string) => void
  }

  let { strip, onSelect, onClose }: Props = $props()

  /**
   * The browser's floating tab strip, drawn in the overlay window over a page.
   *
   * It is the hover reveal the collapsed sidebar gives, reduced to what switching
   * needs: the tabs, their icons, their live state, and a way to pick one. The
   * docked panel's own tools stay in the docked panel   groups, search, notes,
   * per-tab menus and drag reordering are not drawn here and not offered   so
   * this surface has nothing to keep in step with the store beyond its rows.
   *
   * The panel's own geometry is the app layout's, not this document's: the window
   * starts at the application header's bottom edge, and the panel's viewport top
   * follows the user's font size, so its top inside this document is the
   * difference between the two.
   */
  const top = $derived(strip.top - TOAST_OVERLAY_TOP)
</script>

<aside
  class="absolute bottom-0 left-0 flex flex-col overflow-hidden bg-surface shadow-2xl"
  style:top="{top}px"
  style:width="{strip.width}px"
  data-overlay-strip
  aria-label="Browser tabs"
>
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
