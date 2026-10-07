<script lang="ts">
  import { Eye, Globe, Loader2 } from '@lucide/svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserTabLabel, type GlobalBrowserTab } from '$lib/stores/global-browser-types'
  import { browserTabIconUrl } from '../browser/browser-tab-appearance'
  import {
    browserAppearanceAccent,
    browserAppearanceHasIcon,
    browserAppearanceIconUrl
  } from '../browser/browser-group-appearance'

  interface Props {
    tab: GlobalBrowserTab
    selected?: boolean
  }

  let { tab, selected = false }: Props = $props()

  /**
   * One browser tab in the Ctrl+Tab switcher.
   *
   * It reads like the thread picker rows beside it: the tab's icon in the same
   * slot, its label, and a `Browser` badge on the right so the surface a row
   * will switch to is never ambiguous. The icon is the tab's custom icon when it
   * has one, else the page's favicon, else a globe.
   *
   * Before the browser's runtime has been loaded the row is built from the
   * durable tab list rather than the live store (see `switcherBrowserTabs`), and
   * that list carries the icon each tab was wearing when it was written, so a row
   * shown before the browser loads wears the same mark as its row in the strip.
   */
  const runtime = $derived(globalBrowser.runtimeFor(tab.id))
  const label = $derived(browserTabLabel(tab))
  const customIconUrl = $derived(browserTabIconUrl(tab, globalBrowser.tabIconUrl(tab.id)))
  /** The box this tab runs in, so the switcher says which identity it carries
   *  without the user opening the strip. */
  const box = $derived(tab.boxId ? globalBrowser.boxById(tab.boxId) : null)
  const boxAccent = $derived(box ? browserAppearanceAccent(box) : null)
  const boxIcon = $derived(
    box && browserAppearanceHasIcon(box)
      ? browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
      : null
  )
</script>

<div
  class="flex min-h-11 w-full flex-col justify-center px-2.5 py-1.5 text-left transition-colors {selected
    ? 'bg-selected'
    : ''}"
>
  <span class="flex w-full min-w-0 items-center gap-2">
    <span class="flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
      {#if customIconUrl}
        <img src={customIconUrl} alt="" class="h-3.5 w-3.5 rounded-sm object-contain" />
      {:else if runtime.loading}
        <Loader2 size={13} class="animate-spin text-muted" />
      {:else if tab.favicon}
        <img src={tab.favicon} alt="" class="h-3.5 w-3.5 rounded-sm object-contain" />
      {:else}
        <Globe size={13} class="text-muted" />
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{label}</span>
    {#if globalBrowser.hasPeek(tab.id)}
      <span
        role="img"
        class="flex shrink-0 items-center text-accent"
        title="Peek open on this tab"
        aria-label="Peek open on this tab"><Eye size={12} /></span
      >
    {/if}
    {#if box}
      <span
        role="img"
        class="flex h-4 w-4 shrink-0 items-center justify-center"
        title={`In box: ${box.name}`}
        aria-label={`In box ${box.name}`}
      >
        {#if boxIcon}
          <img src={boxIcon} alt="" class="h-3 w-3 rounded-sm object-contain" />
        {:else}
          <span class="h-2 w-2 rounded-full" style="background-color: {boxAccent}"></span>
        {/if}
      </span>
    {/if}
    <StatusPill tone="info">Browser</StatusPill>
  </span>
</div>
