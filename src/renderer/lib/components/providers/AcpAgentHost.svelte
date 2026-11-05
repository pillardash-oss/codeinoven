<script lang="ts">
  import { acpAgentsStore } from '$lib/stores/acp-agents.svelte'
  import AcpAgentEditor from './AcpAgentEditor.svelte'

  /**
   * Renders the ACP agent editor above every view.
   *
   * The editor is a dockable panel, so it cannot live inside the settings page:
   * a docked chip owned by that subtree would disappear the moment the user
   * navigated away from Settings, and "minimize and keep configuring the app" is
   * the whole reason a panel docks. Mounting it here means the ACP rail, any
   * future hand-off and the remembered placement all reach the same single
   * panel from anywhere in the app.
   *
   * The request keys the panel, so editing another agent while one is docked
   * remounts the draft from the newly chosen record instead of keeping the old
   * one behind the chip.
   */
  void acpAgentsStore.load()
</script>

{#if acpAgentsStore.editing !== null}
  {#key acpAgentsStore.editing}
    <AcpAgentEditor agent={acpAgentsStore.editTarget} />
  {/key}
{/if}
