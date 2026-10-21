<script lang="ts">
  import type { Snippet } from 'svelte'
  import { Popover } from 'bits-ui'

  interface Props {
    /** Accessible name of the panel this trigger opens. */
    label: string
    /**
     * Whether hovering the trigger opens the panel, on top of a tap or a click.
     * A reading that a hover already restores elsewhere   a custom tooltip, a title  
     * turns this off, so that a tap is the only way in and the two never stack.
     */
    openOnHover?: boolean
    /** Called as the panel is shown, for readings that are fetched on reveal. */
    onReveal?: () => void
    /** Called as the panel is hidden. */
    onHide?: () => void
    /**
     * A request to open the panel from outside its trigger, as a token that
     * changes on every request. A reading the user asks for by command has no
     * pointer to hover, so the command bumps the token and the panel opens the
     * same way a hover would; clearing the token closes it again.
     */
    openRequest?: number
    /** The panel frame's own padding, since its content is what differs. */
    panelClass?: string
    /** The trigger's own markup. `props` carries bits-ui's own trigger contract
     *  (`onclick`, `aria-expanded`, ids), so it is spread onto the control. */
    trigger: Snippet<[{ props: Record<string, unknown> }]>
    children: Snippet
  }

  let {
    label,
    openOnHover = true,
    onReveal,
    onHide,
    openRequest,
    panelClass = 'p-3',
    trigger,
    children
  }: Props = $props()

  /**
   * The pointer may leave the trigger on its way into the panel. bits-ui bridges that
   * trip with a grace area over the gap, and this is the extra moment it keeps the
   * panel up after the pointer has left both, so a diagonal reach does not drop it.
   */
  const HOVER_CLOSE_GRACE_MS = 150

  /** Held here rather than inside bits-ui because the caller's own reveal and hide
   *  work   flushing live usage, stopping the refresh   rides the same transition. */
  let open = $state(false)

  function handleOpenChange(next: boolean): void {
    open = next
    if (next) onReveal?.()
    else onHide?.()
  }

  /** Whether a request has ever reached this panel, so the cleared request it
   *  mounts with is not read as a dismissal of a panel nobody opened. */
  let requestedOnce = false

  $effect(() => {
    const request = openRequest
    if (request === undefined && !requestedOnce) return
    // Every request carries a new token, and the token of a reading is cleared
    // when the other reading is asked for: a number opens this panel the way a
    // hover would, and clearing it closes whatever it opened, so the two
    // readings are never on screen together.
    requestedOnce = request !== undefined
    handleOpenChange(request !== undefined)
  })
</script>

<!--
  The panel is portaled and positioned by the overlay primitive the rest of the app
  already uses: it escapes every ancestor that hides overflow   the conversation pane,
  a dock column   so a narrow composer can no longer cut its first characters off, it
  turns over and shifts to fit the window it opens in, and it caps its own height to
  the room it has above the trigger.

  Focus never moves: the panel is opened by a pointer as often as by a click, and
  taking focus would end the message being typed in the composer underneath it.
-->
<Popover.Root {open} onOpenChange={handleOpenChange}>
  <Popover.Trigger {openOnHover} openDelay={0} closeDelay={HOVER_CLOSE_GRACE_MS}>
    {#snippet child({ props })}
      {@render trigger({ props })}
    {/snippet}
  </Popover.Trigger>

  <Popover.Portal>
    <Popover.Content
      side="top"
      align="end"
      sideOffset={8}
      collisionPadding={12}
      trapFocus={false}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      class="z-90 w-72 overflow-x-hidden overflow-y-auto border border-border bg-surface shadow-lg {panelClass}"
      style="max-height: var(--bits-popover-content-available-height, 60vh)"
      aria-label={label}
    >
      {@render children()}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
