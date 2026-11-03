<script lang="ts">
  import type { DisplayContextTab } from '$lib/stores/context-sidebar.svelte'
  import DisplaySourcePicker from './DisplaySourcePicker.svelte'
  import DisplayStage from './DisplayStage.svelte'

  /**
   * One display tab's body.
   *
   * The tab itself lives in the dock's own strip, which is where its name, mark,
   * close control, fullscreen and "+" are: this component only decides between
   * the tab's two states. A tab that names no target is the chooser; a tab that
   * names one is that target's live preview. Keying the stage by the target is
   * what makes a pick start a capture and a retarget replace it, instead of
   * leaving the previous device running behind the new picture.
   */

  interface Props {
    tab: DisplayContextTab
  }

  let { tab }: Props = $props()

  const targetKey = $derived(
    tab.sourceKind && tab.sourceId ? `${tab.sourceKind}:${tab.sourceId}` : null
  )
</script>

{#if targetKey}
  {#key targetKey}
    <DisplayStage {tab} />
  {/key}
{:else}
  <DisplaySourcePicker {tab} />
{/if}
