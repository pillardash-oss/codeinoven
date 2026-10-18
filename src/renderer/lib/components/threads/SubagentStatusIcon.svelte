<script lang="ts">
  import CioBan from '@pillardash-oss/cio-icon/CioBan.svelte'
  import CioCheckCircle from '@pillardash-oss/cio-icon/CioCheckCircle.svelte'
  import CioClock from '@pillardash-oss/cio-icon/CioClock.svelte'
  import CioCrossCircle from '@pillardash-oss/cio-icon/CioCrossCircle.svelte'
  import type { AgentToolStatus } from '$shared/types'
  import { SUBAGENT_STATUS_TONE, subagentStatusLabel } from '$lib/subagent-presentation'
  import StatusBadge from '$lib/components/shared/StatusBadge.svelte'

  interface Props {
    status: AgentToolStatus
    size?: number
  }

  let { status, size = 13 }: Props = $props()

  /**
   * The lifecycle state of one sub-agent as a single mark. Every sub-agent
   * surface (trace dropdown, trace card, session header) says "Working",
   * "Completed", "Failed", "Stopped" or "Starting" with this mark and no
   * repeated wording, so the shapes and colors can never drift apart between
   * them.
   */
  const label = $derived(subagentStatusLabel(status))

  /**
   * A running worker carries the same working indicator the project and assistant
   * rows use: the shared status dot in the working tone. Its ring used to spin,
   * which cost a running animation on every worker row at once, and the row
   * already names the worker and its state.
   */
  const workingDotSize = $derived<'sm' | 'md' | 'lg'>(size >= 13 ? 'lg' : size >= 12 ? 'md' : 'sm')
</script>

{#if status === 'running'}
  <!-- The slot keeps the mark's own size so a worker changing from running to
       completed does not shift its row. -->
  <span
    class="flex shrink-0 items-center justify-center"
    style="width: {size}px; height: {size}px"
    role="img"
    aria-label={label}
    title={label}
  >
    <StatusBadge tone="working" size={workingDotSize} decorative />
  </span>
{:else if status === 'completed'}
  <CioCheckCircle
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.completed}"
    role="img"
    aria-label={label}
    title={label}
  />
{:else if status === 'error'}
  <CioCrossCircle
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.error}"
    role="img"
    aria-label={label}
    title={label}
  />
{:else if status === 'aborted'}
  <CioBan
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.aborted}"
    role="img"
    aria-label={label}
    title={label}
  />
{:else}
  <CioClock
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.pending}"
    role="img"
    aria-label={label}
    title={label}
  />
{/if}
