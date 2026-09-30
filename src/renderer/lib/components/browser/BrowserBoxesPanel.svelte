<script lang="ts">
  import { Plus, Settings2 } from '@lucide/svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { jarIdForBox } from '$lib/stores/global-browser-types'
  import { browserAppearanceAccent, browserAppearanceIconUrl } from './browser-group-appearance'
  import BrowserBoxModal from './BrowserBoxModal.svelte'

  /**
   * The browser boxes panel, docked in the browser's right rail.
   *
   * A box is a named cookie jar, so this is where the profile's identities live:
   * one row per box, its colour and icon, how many tabs use it, and which one the
   * tab on screen is in. It belongs to the profile rather than to a page, so it is
   * present with the strip empty, which is also where a user makes their first
   * box before any tab exists.
   *
   * A row's own action opens a tab straight into that box; editing and deleting
   * live behind the row's settings button and the box modal. The list always
   * holds the default box first, because that is the jar the browser's own pages
   * live in, so it is never empty.
   */

  /** The box whose editor is open; `undefined` means closed and null means
   *  "create a new box", so the two states can never be confused. */
  let editorBoxId = $state<string | null | undefined>(undefined)

  const boxes = $derived(globalBrowser.boxes)
  const activeBoxId = $derived(globalBrowser.activeTabBoxId)

  function accent(box: (typeof boxes)[number]): string {
    return browserAppearanceAccent(box)
  }

  /** A box's mark, resolved the way every other identity in the app resolves one:
   *  its picked icon, or its initials on its own colour. A box therefore always
   *  has a mark of its own, so a list of boxes never reads as one generic tool. */
  function iconUrl(box: (typeof boxes)[number]): string | null {
    return browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <div class="flex shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-2">
    <p class="text-xs font-medium text-muted">
      {boxes.length}
      {boxes.length === 1 ? 'box' : 'boxes'}
    </p>
    <button
      type="button"
      class="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-medium text-on-primary transition-colors hover:bg-primary-hover"
      title="Create a box"
      onclick={() => (editorBoxId = null)}
    >
      <Plus size={13} />
      New box
    </button>
  </div>

  <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
    {#each boxes as box (box.id)}
      {@const url = iconUrl(box)}
      <li>
        <div
          class="group flex items-center gap-2 rounded-lg px-2 py-1.5 transition-colors {activeBoxId ===
          box.id
            ? 'bg-elevated'
            : 'hover:bg-elevated'}"
        >
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 text-left"
            title={`Open a new tab in ${box.name}`}
            aria-label={`Open a new tab in ${box.name}`}
            onclick={() => globalBrowser.openNewTabAddress(null, jarIdForBox(box.id))}
          >
            <span class="flex h-4 w-4 shrink-0 items-center justify-center">
              {#if url}
                <img src={url} alt="" class="h-4 w-4 rounded-sm object-contain" />
              {/if}
            </span>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate text-xs text-foreground" style="color: {accent(box)}">
                {box.name}
              </span>
              <span class="truncate text-[0.625rem] text-dimmed">
                {globalBrowser.tabCountInBox(jarIdForBox(box.id))}
                {globalBrowser.tabCountInBox(jarIdForBox(box.id)) === 1 ? 'tab' : 'tabs'}
                {#if activeBoxId === box.id}· in use{/if}
              </span>
            </span>
          </button>
          <button
            type="button"
            class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100"
            title={`Edit ${box.name}`}
            aria-label={`Edit ${box.name}`}
            onclick={() => (editorBoxId = box.id)}
          >
            <Settings2 size={13} />
          </button>
        </div>
      </li>
    {/each}
  </ul>
  <p
    class="shrink-0 border-t border-border px-3 py-1.5 text-[0.625rem] leading-relaxed text-dimmed"
  >
    Tabs in the same box share sign-ins. Pick a box when you open a tab; a tab cannot change boxes
    in place.
  </p>
</div>

{#if editorBoxId !== undefined}
  <BrowserBoxModal boxId={editorBoxId} onClose={() => (editorBoxId = undefined)} />
{/if}
