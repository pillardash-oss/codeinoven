<script lang="ts">
  import { Mic, Volume2, VolumeX } from '@lucide/svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import {
    BROWSER_TAB_CAPTURE_LABEL,
    browserTabIndicators,
    browserTabMuteLabel
  } from '$lib/stores/browser-tab-status'

  interface Props {
    /** The browser tab this indicator reports on. */
    tabId: string
  }

  let { tabId }: Props = $props()

  const runtime = $derived(contextSidebarState.browserRuntime(tabId))
  const indicators = $derived(browserTabIndicators(runtime))
  const muteLabel = $derived(browserTabMuteLabel(runtime.muted))
</script>

<!--
  A tab can be recording and playing audio at the same time, so this renders one
  indicator per active state. The host positions the row over the tab's favicon
  slot and owns the hit area: a real button cannot be nested inside the tab's own
  button, so the capture indicator is a passive image that lets the click through
  to the tab.
-->
{#each indicators as indicator (indicator)}
  {#if indicator === 'capture'}
    <span
      role="img"
      class="pointer-events-none flex h-4 w-4 shrink-0 items-center justify-center text-accent"
      title={BROWSER_TAB_CAPTURE_LABEL}
      aria-label={BROWSER_TAB_CAPTURE_LABEL}
    >
      <Mic size={12} />
    </span>
  {:else}
    <button
      type="button"
      class="pointer-events-auto flex h-4 w-4 shrink-0 items-center justify-center rounded text-accent transition-colors hover:bg-overlay"
      aria-pressed={runtime.muted}
      title={muteLabel}
      aria-label={muteLabel}
      onclick={() => contextSidebarState.toggleBrowserTabMute(tabId)}
    >
      {#if runtime.muted}
        <VolumeX size={12} />
      {:else}
        <Volume2 size={12} />
      {/if}
    </button>
  {/if}
{/each}
