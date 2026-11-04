<script lang="ts">
  import type { CitedEntry } from '$shared/cited-work'
  import CitedEntryRow from './CitedEntryRow.svelte'

  interface Props {
    /** The work the settled turn cited, one row each. */
    entries: CitedEntry[]
    /** The conversation whose workspace the entries live in. */
    projectId?: string | null
    /** The thread the card is drawn in, which is where a served design opens. */
    threadId?: string | null
  }

  let { entries, projectId = null, threadId = null }: Props = $props()
</script>

<!-- The turn cited work of its own and left no file changes behind, so the cards
are the whole of what it produced: one bordered surface, one row per entry. A
turn that also changed files shows these rows inside its changes card instead. -->
<div class="min-w-0 border border-border bg-surface">
  {#each entries as entry (entry.path)}
    <CitedEntryRow {entry} {projectId} {threadId} density="card" />
  {/each}
</div>
