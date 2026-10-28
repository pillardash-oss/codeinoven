<script lang="ts">
  import MediaActivityIndicator from '$lib/components/speech/MediaActivityIndicator.svelte'
  import { captureActivities } from '$shared/media-activity'
  import CioBrowser from '@pdslng/cio-icon/CioBrowser.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { browserTabMuteLabel } from '$lib/stores/browser-tab-status'

  /**
   * The header's centre while the global browser is the active view.
   *
   * Where every other view shows the open thread's title, the browser shows the
   * page on screen: its favicon, its title, a spinner while a navigation is in
   * flight, and its audio/recording indicators. It is deliberately the same
   * information a tab head carries, so the header and the strip never disagree
   * about which page is live.
   */

  const tab = $derived(globalBrowser.activeTab)
  const runtime = $derived(tab ? globalBrowser.runtimeFor(tab.id) : null)
</script>

<div class="flex min-w-0 flex-1 items-center justify-center px-2">
  {#if tab && runtime}
    <!-- The page's title is capped by the header shell's centre width, exactly
         like the thread title in the other views. -->
    <div
      class="titlebar-no-drag flex min-w-0 max-w-[var(--app-header-center-max-width)] items-center gap-2"
    >
      <span class="flex h-4 w-4 shrink-0 items-center justify-center">
        {#if runtime.loading}
          <CioSpinner size={13} class="animate-spin text-muted" />
        {:else if tab.favicon}
          <img src={tab.favicon} alt="" class="h-4 w-4 object-contain" />
        {:else}
          <CioBrowser size={13} class="text-dimmed" />
        {/if}
      </span>
      <h1
        class="truncate text-[0.6875rem] font-medium tracking-tight text-foreground"
        title={tab.url || tab.title}
      >
        {tab.title}
      </h1>
      {#if runtime.capturing}
        <span class="flex shrink-0 items-center justify-center gap-0.5">
          {#each captureActivities(runtime) as kind (kind)}
            <MediaActivityIndicator {kind} />
          {/each}
        </span>
      {/if}
      {#if runtime.audible || runtime.muted}
        <button
          type="button"
          class="flex h-5 w-5 shrink-0 items-center justify-center text-accent transition-colors hover:bg-elevated"
          aria-pressed={runtime.muted}
          title={browserTabMuteLabel(runtime.muted)}
          aria-label={browserTabMuteLabel(runtime.muted)}
          onclick={() => globalBrowser.toggleMute(tab.id)}
        >
          {#if runtime.muted}
            <MediaActivityIndicator kind="audio" muted decorative />
          {:else}
            <MediaActivityIndicator kind="audio" decorative />
          {/if}
        </button>
      {/if}
    </div>
  {:else}
    <div class="pointer-events-none">
      <h1 class="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-dimmed">
        Browser
      </h1>
    </div>
  {/if}
</div>
