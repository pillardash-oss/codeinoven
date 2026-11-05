<script lang="ts">
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'

  interface Props {
    harnessId: string
    size?: number
  }

  let { harnessId, size = 12 }: Props = $props()
</script>

<!--
  One icon for every harness a picker can switch to. A dedicated harness has its
  own bundled mark; an ACP agent wears its uploaded artwork, the mark of the
  harness its command starts, or the app's vendor icon. The terminal glyph this
  used to fall back to said nothing about which harness would run the model.
-->
<AgentIcon agentId={harnessId} {size} />
