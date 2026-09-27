<script lang="ts">
  import { Globe, X } from '@lucide/svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import BrowserNoteEditor from './BrowserNoteEditor.svelte'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  /**
   * The browser view's right rail.
   *
   * It is the browser's answer to the context sidebar of a thread: the place
   * where the tab's own context lives. The first panel is the note the user
   * keeps for the page; the agent conversation for the tab joins it here.
   */

  const tab = $derived(globalBrowser.activeTab)
</script>

<aside
  class="flex h-full w-80 shrink-0 flex-col border-l bg-surface"
  data-region="browser-context-sidebar"
  aria-label="Tab notes"
>
  <div class="flex h-10 shrink-0 items-center gap-1 border-b px-3">
    <h2 class="text-[0.6875rem] font-semibold uppercase tracking-[0.16em] text-dimmed">
      Tab notes
    </h2>
    <button
      type="button"
      class="ml-auto flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
      aria-label="Close tab notes"
      title="Close tab notes"
      onclick={onClose}
    >
      <X size={14} />
    </button>
  </div>

  {#if tab}
    {#key tab.id}
      <BrowserNoteEditor {tab} />
    {/key}
  {:else}
    <div class="flex flex-1 flex-col items-center gap-3 px-6 py-10 text-center">
      <Globe size={20} class="text-dimmed" />
      <p class="text-xs leading-relaxed text-dimmed">
        Open a tab to keep a note about the page. Notes stay with their tab.
      </p>
    </div>
  {/if}
</aside>
