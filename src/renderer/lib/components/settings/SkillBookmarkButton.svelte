<script lang="ts">
  import { Bookmark } from '@lucide/svelte'
  import { skillBookmarkState } from '$lib/stores/skill-bookmarks.svelte'
  import type { SkillMarketEntry } from '$shared/types'

  interface Props {
    /** Marketplace skill this control bookmarks or unbookmarks. */
    entry: SkillMarketEntry
    /**
     * Action-specific description of the control, e.g. `Bookmark foo`.
     * Required so no call site can ship an unnamed icon button.
     */
    title: string
    size?: number
    /** Render the state as text beside the icon instead of an icon-only button. */
    labelled?: boolean
    class?: string
  }

  let { entry, title, size = 14, labelled = false, class: className = '' }: Props = $props()

  let bookmarked = $derived(skillBookmarkState.isBookmarked(entry.id))

  /** Row-level bookmarks must never trigger the row's own click. */
  function toggle(event: MouseEvent): void {
    event.preventDefault()
    event.stopPropagation()
    skillBookmarkState.toggle(entry)
  }
</script>

<button
  type="button"
  {title}
  aria-label={title}
  aria-pressed={bookmarked}
  class="flex shrink-0 items-center justify-center gap-1.5 rounded-lg transition-colors {bookmarked
    ? 'text-accent'
    : 'text-muted hover:text-foreground'} {labelled ? 'h-8 px-2.5 text-xs font-medium' : 'h-7 w-7'}
  {className}"
  onclick={toggle}
>
  <Bookmark {size} fill={bookmarked ? 'currentColor' : 'none'} />
  {#if labelled}<span>{bookmarked ? 'Bookmarked' : 'Bookmark'}</span>{/if}
</button>
