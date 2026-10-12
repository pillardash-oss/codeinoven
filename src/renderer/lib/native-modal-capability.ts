import { MAX_NATIVE_DOCK_NODES, NATIVE_DOCK_TAGS } from '$shared/native-dock'

/**
 * What the projection is being asked to draw.
 *
 * A bounded floating panel is not a modal: it never owns the window or the
 * keyboard, which is why it carries one extra refusal a dialog does not.
 */
export interface NativeProjectionScope {
  panel?: boolean
}

/**
 * Why this dialog cannot be drawn natively, or null when it can.
 *
 * The projection is a copy of the panel's markup, so anything it cannot carry
 * faithfully has to be refused rather than half-drawn: a tag with no inert
 * equivalent, a rich editor whose content lives outside the DOM tree, a control
 * that opens an OS popup the native document cannot own, or an input whose
 * behaviour depends on the browser's own widget.
 *
 * Interactive elements are no longer a reason to refuse. A `div[role=option]`,
 * a `div[role=button]` or any focusable element is projected with an identity,
 * and the native document delivers the pointer and the keyboard back to it, so
 * refusing them was what kept command palettes and list dialogs on the DOM
 * presentation   and the browser hidden behind them.
 *
 * The reason is returned rather than logged so the caller can name the offending
 * node in the durable log, which is the only way to tell a real limitation from
 * a projection bug.
 */
export function nativeModalRefusal(
  root: HTMLElement,
  scope: NativeProjectionScope = {}
): string | null {
  let count = 0
  /** Name the node, so the durable log can tell a limitation from a bug. */
  function describe(node: Element): string {
    const role = node.getAttribute('role')
    const classes = node.className.toString().slice(0, 60)
    return `<${node.localName}${role ? ` role="${role}"` : ''} class="${classes}">`
  }
  function visit(node: Node, depth: number): string | null {
    if (++count > MAX_NATIVE_DOCK_NODES) return 'its content is larger than the projection budget'
    if (depth > 24) return 'its content is nested deeper than the projection can carry'
    if (!(node instanceof Element)) return null
    if (node.classList.contains('hidden') || node.hasAttribute('hidden')) return null
    const field = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement
    if (!NATIVE_DOCK_TAGS.has(node.localName)) return `${describe(node)} has no inert equivalent`
    if (field && node instanceof HTMLInputElement && !INPUT_TYPES.has(node.type))
      return `${describe(node)} keeps its own widget`
    // A floating panel does not own the keyboard: the overlay window it is drawn
    // in stays non-key so the app keeps every shortcut, and main forwards a key
    // back to its source only for a modal. A field drawn there would take a
    // caret and no keystrokes, so a panel that needs typing keeps the app
    // window, where typing has always worked.
    if (scope.panel && field && !node.hasAttribute('readonly') && !node.hasAttribute('disabled'))
      return `${describe(node)} is an editable field, and a floating panel does not own the keyboard`
    if (node.hasAttribute('contenteditable'))
      return `${describe(node)} is a rich editor, which cannot be projected`
    if (node.hasAttribute('aria-haspopup') && node.getAttribute('aria-haspopup') !== 'false')
      return `${describe(node)} opens its own popup, which cannot be projected`
    for (const child of node.childNodes) {
      const refusal = visit(child, depth + 1)
      if (refusal) return refusal
    }
    return null
  }
  return visit(root, 0)
}

/** Text-shaped inputs, whose value the field bridge can carry both ways. */
const INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'range', 'color'])
