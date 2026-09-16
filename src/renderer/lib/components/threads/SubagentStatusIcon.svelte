<script lang="ts">
  import { CheckCircle2, CircleSlash2, Clock, Loader2, XCircle } from '@lucide/svelte'
  import type { AgentToolStatus } from '$shared/types'
  import { SUBAGENT_STATUS_TONE, subagentStatusLabel } from '$lib/subagent-presentation'

  interface Props {
    status: AgentToolStatus
    size?: number
  }

  let { status, size = 13 }: Props = $props()

  /**
   * The lifecycle state of one sub-agent as a single icon. Every sub-agent
   * surface (trace dropdown, trace card, session header) says "Working",
   * "Completed", "Failed", "Stopped" or "Starting" with this icon and no
   * repeated wording, so the shapes and colors can never drift apart between
   * them.
   */
  const label = $derived(subagentStatusLabel(status))
</script>

{#if status === 'running'}
  <Loader2
    {size}
    class="shrink-0 animate-spin {SUBAGENT_STATUS_TONE.running}"
    role="img"
    aria-label={label}
    title={label}
  />
{:else if status === 'completed'}
  <CheckCircle2
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.completed}"
    role="img"
    aria-label={label}
    title={label}
  />
{:else if status === 'error'}
  <XCircle
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.error}"
    role="img"
    aria-label={label}
    title={label}
  />
{:else if status === 'aborted'}
  <CircleSlash2
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.aborted}"
    role="img"
    aria-label={label}
    title={label}
  />
{:else}
  <Clock
    {size}
    class="shrink-0 {SUBAGENT_STATUS_TONE.pending}"
    role="img"
    aria-label={label}
    title={label}
  />
{/if}
