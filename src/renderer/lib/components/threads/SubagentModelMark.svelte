<script lang="ts">
  import CioSubagent from '@pdslng/cio-icon/CioSubagent.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import type { AgentSubagentActivity } from '$shared/types'
  import AssistantIcon from '../icons/cio/AssistantIcon.svelte'
  import {
    subagentProvider,
    type SubagentInheritedSelection
  } from './subagent-session-view-helpers'

  interface Props {
    activity: AgentSubagentActivity
    /** Square mark edge in pixels. */
    size?: number
    class?: string
    /** The parent session's provider, for a worker whose harness reports none. */
    inherited?: SubagentInheritedSelection
  }

  let { activity, size = 12, class: className = '', inherited }: Props = $props()

  const providers = $derived(providerCatalog.allCached())
  /**
   * The brand of the model running this worker.
   *
   * A worker's provider is only known when the harness named it, or when the
   * parent session's provider was inherited by the same harness. Without one,
   * the worker wears the mark of the harness that ran it, which still names the
   * company; only a worker with no brand at all keeps the sub-agent glyph.
   */
  const provider = $derived(subagentProvider(activity, providers, inherited))
  const providerMark = $derived.by(() => {
    if (!provider) return null
    return { name: provider.name, id: provider.id }
  })
</script>

{#if providerMark}
  <VendorIcon name={providerMark.name} id={providerMark.id} {size} class={className} />
{:else if activity.harnessId}
  <AgentIcon agentId={activity.harnessId} {size} class={className} />
{:else if activity.pawn}
  <AssistantIcon mark="agent" {size} class={className} />
{:else}
  <CioSubagent {size} class={className} />
{/if}
