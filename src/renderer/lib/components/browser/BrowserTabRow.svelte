<script lang="ts">
  import { Globe, Loader2, Mic, Moon, Volume2, VolumeX, X } from '@lucide/svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { BROWSER_TAB_CAPTURE_LABEL, browserTabMuteLabel } from '$lib/stores/browser-tab-status'
  import type { GlobalBrowserTab } from '$lib/stores/global-browser-types'

  interface Props {
    tab: GlobalBrowserTab
  }

  let { tab }: Props = $props()

  /**
   * One row in the browser tab strip.
   *
   * It reads like a thread row: what the page is, whether it is still loading,
   * and whether it wants the user (audio or a live capture). The row's own
   * controls sit in an absolutely positioned cluster so they are never nested
   * inside the row's activation button, which is invalid markup and would also
   * make the mute toggle fire the row.
   */

  const runtime = $derived(globalBrowser.runtimeFor(tab.id))
  const active = $derived(globalBrowser.activeTabId === tab.id)

  function closeTab(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    globalBrowser.close(tab.id)
  }
</script>

<div class="group relative flex items-center">
  <button
    type="button"
    class="flex min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left transition-colors {active
      ? 'bg-elevated'
      : 'hover:bg-elevated'}"
    aria-current={active}
    title={tab.url || tab.title}
    onclick={() => globalBrowser.activate(tab.id)}
    onauxclick={(event: MouseEvent) => {
      if (event.button === 1) closeTab(event)
    }}
  >
    <span class="flex h-4 w-4 shrink-0 items-center justify-center">
      {#if runtime.loading}
        <Loader2 size={13} class="animate-spin text-muted" />
      {:else if tab.favicon}
        <img src={tab.favicon} alt="" class="h-4 w-4 rounded-sm object-contain" />
      {:else}
        <Globe size={12} class="text-dimmed" />
      {/if}
    </span>
    <span
      class="min-w-0 flex-1 truncate text-xs {tab.hibernated
        ? 'text-dimmed'
        : 'text-foreground'} {active ? 'font-medium' : ''}"
    >
      {tab.title}
    </span>
  </button>

  <div class="pointer-events-none absolute right-1 flex items-center gap-0.5">
    {#if runtime.capturing}
      <span
        role="img"
        class="pointer-events-none flex h-6 w-6 items-center justify-center text-accent"
        title={BROWSER_TAB_CAPTURE_LABEL}
        aria-label={BROWSER_TAB_CAPTURE_LABEL}
      >
        <Mic size={12} />
      </span>
    {/if}
    {#if runtime.audible || runtime.muted}
      <button
        type="button"
        class="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md text-accent transition-colors hover:bg-overlay"
        aria-pressed={runtime.muted}
        title={browserTabMuteLabel(runtime.muted)}
        aria-label={browserTabMuteLabel(runtime.muted)}
        onclick={(event: MouseEvent) => {
          event.stopPropagation()
          globalBrowser.toggleMute(tab.id)
        }}
      >
        {#if runtime.muted}
          <VolumeX size={12} />
        {:else}
          <Volume2 size={12} />
        {/if}
      </button>
    {:else if tab.hibernated}
      <span
        role="img"
        class="pointer-events-none flex h-6 w-6 items-center justify-center text-dimmed"
        title="Hibernated to save memory. Open the tab to reload it."
        aria-label="Hibernated tab"
      >
        <Moon size={12} />
      </span>
    {/if}
    <button
      type="button"
      class="pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md text-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100"
      aria-label={`Close ${tab.title}`}
      title={`Close ${tab.title}`}
      onclick={closeTab}
    >
      <X size={12} />
    </button>
  </div>
</div>
