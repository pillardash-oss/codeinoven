<script lang="ts">
  import { ChevronDown, ChevronLeft, Plus } from '@lucide/svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { jarIdForBox, type GlobalBrowserBox } from '$lib/stores/global-browser-types'
  import { browserAppearanceAccent, browserAppearanceIconUrl } from './browser-group-appearance'
  import BrowserBoxEditor from './BrowserBoxEditor.svelte'

  /**
   * The browser boxes panel, docked in the browser's right rail.
   *
   * A box is a named cookie jar, so this is where the profile's identities live:
   * one row per box, its colour and icon, how many tabs use it, and which one the
   * tab on screen is in. It belongs to the profile rather than to a page, so it is
   * present with the strip empty, which is also where a user makes their first
   * box before any tab exists.
   *
   * Making a box is a page of the panel, not a dialog: the list sits one chevron
   * back, and the form is the panel's own work. Changing one is a fold on its row,
   * the same shape the extensions tool uses for its own settings, so the list
   * stays in view while the fields are edited and nothing covers the row it edits.
   * A row's own action opens a tab straight into that box; the fold holds the
   * editor and the box's destructive halves, each behind its confirmation. The
   * list always holds the default box first, because that is the jar the
   * browser's own pages live in, so it is never empty.
   */

  /** Whether the panel is showing the box list or the create page. */
  let creating = $state(false)

  /** The box whose editor is folded open on its row, or null. One at a time, so
   *  two drafts can never both claim the fold. */
  let expandedBoxId = $state<string | null>(null)

  const boxes = $derived(globalBrowser.boxes)
  const activeBoxId = $derived(globalBrowser.activeTabBoxId)

  function accent(box: GlobalBrowserBox): string {
    return browserAppearanceAccent(box)
  }

  /** A box's mark, resolved the way every other identity in the app resolves one:
   *  its picked icon, or its initials on its own colour. A box therefore always
   *  has a mark of its own, so a list of boxes never reads as one generic tool. */
  function iconUrl(box: GlobalBrowserBox): string | null {
    return browserAppearanceIconUrl(box, globalBrowser.boxIconUrl(box.id))
  }

  function openCreate(): void {
    expandedBoxId = null
    creating = true
  }

  function toggleExpanded(boxId: string): void {
    expandedBoxId = expandedBoxId === boxId ? null : boxId
  }
</script>

{#if creating}
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
      <button
        type="button"
        class="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
        title="Back to boxes"
        aria-label="Back to boxes"
        onclick={() => (creating = false)}
      >
        <ChevronLeft size={15} />
      </button>
      <p class="text-xs font-medium text-foreground">New box</p>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto p-3">
      <p class="mb-3 text-[0.625rem] leading-relaxed text-dimmed">
        A box is its own cookies and site data, so it holds its own sign-ins. Tabs in the same box
        share them; tabs in different boxes do not.
      </p>
      <BrowserBoxEditor box={null} onSaved={() => (creating = false)} />
    </div>
  </div>
{:else}
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
        onclick={openCreate}
      >
        <Plus size={13} />
        New box
      </button>
    </div>

    <ul class="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
      {#each boxes as box (box.id)}
        {@const url = iconUrl(box)}
        {@const expanded = expandedBoxId === box.id}
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
              class={[
                'flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors group-hover:opacity-100 hover:bg-overlay hover:text-foreground focus-visible:opacity-100',
                expanded ? 'opacity-100' : 'opacity-0'
              ]}
              title={expanded ? `Hide ${box.name} settings` : `Settings for ${box.name}`}
              aria-label={expanded ? `Hide ${box.name} settings` : `Settings for ${box.name}`}
              aria-expanded={expanded}
              aria-controls="box-settings-{box.id}"
              onclick={() => toggleExpanded(box.id)}
            >
              <ChevronDown size={13} class={expanded ? 'rotate-180' : ''} />
            </button>
          </div>

          {#if expanded}
            <div id="box-settings-{box.id}" class="mb-1 rounded-lg border p-3">
              <BrowserBoxEditor {box} onDeleted={() => (expandedBoxId = null)} />
            </div>
          {/if}
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
{/if}
