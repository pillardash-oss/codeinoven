<script lang="ts">
  import {
    AUTHORED_WORK_ICON_BY_KIND,
    AUTHORED_WORK_NAME_BY_KIND
  } from '$lib/authored-work-presentation'
  import type { AuthoredWorkKind } from '$shared/ipc-contract'

  /**
   * The durable marks for the authored-work sessions a thread has entered.
   *
   * One thread can have designed something and later cut a video about it, so
   * this draws every session rather than the last one, in the canonical order
   * the shared table defines. Shared because every row that lists a thread owes
   * the user the same answer about what that thread produced.
   */
  interface Props {
    /** Sessions the thread has entered, already in canonical order. */
    kinds: readonly AuthoredWorkKind[]
    /** Glyph size in pixels, so a dense row can match its neighbours. */
    size?: number
  }

  let { kinds, size = 11 }: Props = $props()
</script>

{#each kinds as kind (kind)}
  {@const WorkIcon = AUTHORED_WORK_ICON_BY_KIND[kind]}
  <span
    class="flex shrink-0 items-center text-muted"
    title="{AUTHORED_WORK_NAME_BY_KIND[kind]} thread"
    aria-label="{AUTHORED_WORK_NAME_BY_KIND[kind]} thread"
  >
    <WorkIcon {size} strokeWidth={1.8} aria-hidden="true" />
  </span>
{/each}
