<script lang="ts">
  import { Server } from '@lucide/svelte'
  import FullscreenPanelDialog from '$lib/components/workspace/FullscreenPanelDialog.svelte'
  import TerminalPanel from '$lib/components/terminal/TerminalPanel.svelte'
  import { ovenMarkUrl } from '$lib/stores/ovens.svelte'
  import type { Oven } from '$shared/ovens'

  interface Props {
    oven: Oven
    onClose: () => void
  }

  let { oven, onClose }: Props = $props()

  let markUrl = $derived(ovenMarkUrl(oven))

  /** The surface has one section, the Oven's own shell, so its strip names the
   *  Oven and nothing else. */
  let tabs = $derived([{ id: oven.id, title: oven.name }])
</script>

<!--
  One Oven's own login shell, full screen.

  It is not tied to a chat or a checkout: "Open Oven" is how a user reaches the
  machine itself   read a service log, install a harness, fix SSH   without
  first creating a project on it. The shell lands in the Oven's home directory
  and is keyed by the Oven, so the surface always shows that Oven's own live
  session.

  It is the app's canonical full screen surface, so it shares the draggable
  title bar, the traffic-light inset and the minimize control with the browser,
  terminal and pull request reader. The strip carries the Oven's own mark, which
  is why this surface passes no `onNew`, `onCloseTab` or `onMoveTab`: it is one
  section, switched to and minimized, never opened or closed.

  Closing the surface never kills the shell. The session belongs to the terminal
  session manager, so reopening the Oven reattaches the same live shell with its
  scrollback intact.
-->
<FullscreenPanelDialog
  {tabs}
  activeTabId={oven.id}
  minimizeLabel={`Minimize ${oven.name} shell`}
  scrim={false}
  onSelect={() => {}}
  onMinimize={onClose}
>
  {#snippet icon()}
    {#if markUrl}
      <img src={markUrl} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
    {:else}
      <Server size={13} class="shrink-0" />
    {/if}
  {/snippet}
  {#snippet actions()}
    <span class="text-[0.625rem] text-dimmed">SSH shell</span>
  {/snippet}
  <div class="min-h-0 flex-1">
    {#key oven.id}
      <TerminalPanel terminalId="oven-shell" projectId="" threadId="" ovenId={oven.id} />
    {/key}
  </div>
</FullscreenPanelDialog>
