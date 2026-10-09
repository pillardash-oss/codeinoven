<script lang="ts">
  import { Minimize2, Server } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import TerminalPanel from '$lib/components/terminal/TerminalPanel.svelte'
  import { ovenMarkUrl } from '$lib/stores/ovens.svelte'
  import type { Oven } from '$shared/ovens'

  interface Props {
    /** The Oven whose own shell is open, or null when the surface is closed. */
    oven: Oven | null
    onClose: () => void
  }

  let { oven, onClose }: Props = $props()

  let markUrl = $derived(oven ? ovenMarkUrl(oven) : null)
</script>

<!--
  One Oven's own login shell, full screen.

  It is not tied to a chat or a checkout: "Open Oven" is how a user reaches the
  machine itself   read a service log, install a harness, fix SSH   without
  first creating a project on it. The shell lands in the Oven's home directory
  and is keyed by the Oven, so switching Ovens inside the surface mounts that
  Oven's own session instead of leaving one shell pointed at the other machine.

  This is a `Modal` with `placement="fullscreen"`, so it shares the portal, the
  stacking layer, Cmd/Ctrl+W, and browser-view suppression with every other
  surface. The scrim is off because the terminal repaints every frame, and its
  full-window `backdrop-blur` would composite under that renderer and tear it.
  `trapFocus` is off for the same reason the app's other full screen surfaces
  disable it: the surface covers the window, so nothing behind it is reachable.

  Closing the surface never kills the shell. The session belongs to the terminal
  session manager, so reopening the Oven reattaches the same live shell with its
  scrollback intact.
-->
{#if oven}
  <Modal
    open
    title={`${oven.name} shell`}
    {onClose}
    placement="fullscreen"
    chrome={false}
    scrim={false}
    trapFocus={false}
    panelClass="bg-app"
  >
    <div class="flex h-full min-h-0 flex-col">
      <div class="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        {#if markUrl}
          <img src={markUrl} alt="" class="h-3.5 w-3.5 shrink-0 object-contain" />
        {:else}
          <Server size={13} class="shrink-0 text-muted" />
        {/if}
        <span class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground"
          >{oven.name}</span
        >
        <span class="shrink-0 text-[0.625rem] text-dimmed">SSH shell</span>
        <button
          type="button"
          class="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-elevated hover:text-foreground"
          title="Close Oven shell"
          aria-label="Close Oven shell"
          onclick={onClose}
        >
          <Minimize2 size={14} />
        </button>
      </div>
      <div class="min-h-0 flex-1">
        {#key oven.id}
          <TerminalPanel terminalId="oven-shell" projectId="" threadId="" ovenId={oven.id} />
        {/key}
      </div>
    </div>
  </Modal>
{/if}
