import type { Attachment } from 'svelte/attachments'

/**
 * The one home for the app's global panels while the rail that shows them
 * changes with the view.
 *
 * Notifications and sticky notes belong to the app, not to a project, a thread,
 * or the browser, but each view owns its own right rail: the workspace shell's
 * context sidebar, the Scope and Settings rail, and the browser rail. Rendering
 * the panel inside each rail destroyed and rebuilt it on every view switch, so
 * its scroll position and any in-progress editor state (a sticky note's undo
 * history, an expanded error's stack trace) reset. The panel is instead mounted
 * once, at the app shell (`AppPanelHost.svelte`), and its root element is moved
 * into whichever rail's body slot is on screen. Moving a DOM element keeps the
 * Svelte component instance alive, so nothing remounts across a view change.
 *
 * A rail offers a slot by attaching `appPanelSlot` to its panel body. The host
 * registers itself with `appPanelHost`. Only one slot is on screen at a time:
 * the workspace slot is dropped while Scope, Settings, or the browser replaces
 * the shell, and the other two rails only exist in their own views.
 */
interface AppPanelHostBinding {
  host: HTMLElement
  fallback: HTMLElement
}

class AppPanelPortal {
  private binding: AppPanelHostBinding | null = null
  private slots: HTMLElement[] = []

  registerHost(binding: AppPanelHostBinding): void {
    this.binding = binding
    this.sync()
  }

  unregisterHost(host: HTMLElement): void {
    if (this.binding?.host === host) this.binding = null
  }

  registerSlot(element: HTMLElement): void {
    if (!this.slots.includes(element)) this.slots.push(element)
    this.sync()
  }

  unregisterSlot(element: HTMLElement): void {
    const index = this.slots.indexOf(element)
    if (index >= 0) this.slots.splice(index, 1)
    this.sync()
  }

  private sync(): void {
    const binding = this.binding
    if (!binding) return
    // The last slot to arrive wins. During a view switch the incoming rail's
    // slot is registered after the outgoing one, so it is the one on screen.
    const target = this.slots.at(-1) ?? binding.fallback
    if (binding.host.parentElement !== target) target.appendChild(binding.host)
  }
}

export const appPanelPortal = new AppPanelPortal()

/**
 * Attach to a rail's panel body to offer it as the app panels' slot. The body
 * that carries this is only rendered while its rail is the view on screen.
 */
export const appPanelSlot: Attachment<HTMLElement> = (node) => {
  appPanelPortal.registerSlot(node)
  return () => appPanelPortal.unregisterSlot(node)
}

/**
 * Attach to the app panel host's root. Its parent is the hidden fallback the
 * host returns to whenever no rail slot is on screen, so the panel stays
 * mounted (and keeps its state) through the switch.
 */
export const appPanelHost: Attachment<HTMLElement> = (node) => {
  const fallback = node.parentElement
  if (!fallback) return
  appPanelPortal.registerHost({ host: node, fallback })
  return () => appPanelPortal.unregisterHost(node)
}
