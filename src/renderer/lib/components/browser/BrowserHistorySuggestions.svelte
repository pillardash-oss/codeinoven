<script lang="ts">
  import { Clock } from '@lucide/svelte'
  import { browserLibraryHost, type BrowserHistoryEntry } from '$shared/browser/browser-library'
  import { relativeTime } from '$lib/format/relative-time'

  interface Props {
    /** Stable listbox id, so the field that drives the list can point at it. */
    listId: string
    /** The pages to offer, best first. The caller owns the ranking. */
    suggestions: readonly BrowserHistoryEntry[]
    /** The highlighted row, or -1 while the field's own text is what Enter opens. */
    highlight: number
    /** Move the highlight, so hovering a row and arrowing to it are one state. */
    onHighlight: (index: number) => void
    /** Open a row's page. */
    onOpen: (entry: BrowserHistoryEntry) => void
    /** Tighter rows, for a drawer in a docked panel rather than the app's palette. */
    compact?: boolean
  }

  let { listId, suggestions, highlight, onHighlight, onOpen, compact = false }: Props = $props()

  /**
   * The pages the user has already visited, offered under the address field they
   * are typing in.
   *
   * Both fields that offer history render this one list   the app's address
   * palette, and the thread browser's address drawer   so the ranking's
   * presentation, the keyboard highlight and the rows themselves are written
   * once and the two surfaces cannot drift apart.
   *
   * A row takes the mousedown rather than letting the field blur: the pick is a
   * click, and a field that closes on blur would take the drawer away before the
   * click landed.
   */

  function rowLabel(entry: BrowserHistoryEntry): string {
    return `Open ${entry.title}`
  }
</script>

<div>
  <p
    class="flex items-center gap-1.5 px-2.5 pb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-dimmed"
  >
    <Clock size={10} aria-hidden="true" />
    History
  </p>
  <!-- A listbox driven by the field above: the arrows move the highlight, so the
       rows are options rather than a second set of controls. -->
  <div id={listId} role="listbox" aria-label="Browsing history suggestions">
    {#each suggestions as entry, index (entry.url)}
      <button
        type="button"
        id={`${listId}-option-${index}`}
        role="option"
        aria-selected={index === highlight}
        class={[
          'flex w-full items-center gap-2.5 rounded-lg px-2.5 text-left outline-none transition-colors',
          compact ? 'py-1' : 'py-1.5',
          index === highlight ? 'bg-overlay text-foreground' : 'text-muted hover:bg-elevated'
        ]}
        aria-label={rowLabel(entry)}
        title={entry.url}
        onmousedown={(event) => event.preventDefault()}
        onmouseenter={() => onHighlight(index)}
        onclick={() => onOpen(entry)}
      >
        <span class="min-w-0 flex-1">
          <span class={['block truncate', compact ? 'text-xs' : 'text-sm']}>{entry.title}</span>
          <span
            class={[
              'block truncate text-dimmed',
              compact ? 'text-[0.625rem]' : 'text-[0.6875rem]'
            ]}
          >
            {browserLibraryHost(entry.url)}
          </span>
        </span>
        <span
          class={[
            'shrink-0 tabular-nums text-dimmed',
            compact ? 'text-[0.625rem]' : 'text-[0.6875rem]'
          ]}
        >
          {relativeTime(entry.visitedAt)}
        </span>
      </button>
    {/each}
  </div>
</div>
