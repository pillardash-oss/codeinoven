/**
 * Restore the composer's saved caret whenever a focus-stealing overlay (the
 * model/thinking/account/permission/inference menus) closes.
 *
 * Call once per overlay during component initialization. The tracker observes
 * the open flag and fires the restore callback only on the open-to-closed
 * transition, matching the per-menu `wasOpen` bookkeeping it replaces.
 */
export function trackMenuCloseFocus(isOpen: () => boolean, restoreFocus: () => void): void {
  let wasOpen = false
  $effect(() => {
    const open = isOpen()
    if (wasOpen && !open) restoreFocus()
    wasOpen = open
  })
}
