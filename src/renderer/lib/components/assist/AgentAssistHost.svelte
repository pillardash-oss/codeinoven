<script lang="ts">
  import AgentAssistDialog from './AgentAssistDialog.svelte'
  import { agentAssist } from './agent-assist-store.svelte'

  /**
   * Mount point for the shared agent setup dialog.
   *
   * Rendered once at the app root so every "with agent" control opens the same
   * panel regardless of which view raised it. The mount is conditional, so the
   * dialog seeds itself from the request that opened it and nothing keeps a
   * stale handoff alive after it closes.
   */
  const request = $derived(agentAssist.request)
</script>

{#if request}
  <AgentAssistDialog {request} onClose={() => agentAssist.close()} />
{/if}
