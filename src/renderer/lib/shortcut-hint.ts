import { formatKeyCombo } from '$lib/keymap/keymap'

export interface ShortcutHintOptions {
  /** Symbolic key tokens, e.g. ['mod', '1'] — rendered platform-aware. */
  keys: readonly string[]
  /** Vertical offset from the element's top edge. Defaults to -8px (above). */
  top?: string
  /** Horizontal offset from the element's right edge. Defaults to 4px. */
  right?: string
}

/**
 * Svelte action that displays the element's keyboard shortcut as a small kbd
 * badge while the element is hovered or focused. The badge is appended to the
 * element itself, so the element must be a positioning context (the action
 * adds `relative` when the element is statically positioned).
 */
export function shortcutHint(node: HTMLElement, options: ShortcutHintOptions) {
  let badge: HTMLSpanElement | null = null
  let show = false
  let current: ShortcutHintOptions = options

  function position() {
    if (!badge) return
    badge.style.top = current.top ?? '-0.5rem'
    badge.style.right = current.right ?? '0.25rem'
  }

  function render() {
    if (!current.keys.length) {
      badge?.remove()
      badge = null
      return
    }
    if (!badge) {
      badge = document.createElement('span')
      badge.setAttribute('aria-hidden', 'true')
      badge.className = shortcutHintBadgeClass
      badge.style.opacity = '0'
      badge.style.pointerEvents = 'none'
      node.appendChild(badge)
      if (getComputedStyle(node).position === 'static') {
        node.classList.add('relative')
        node.dataset.shortcutHintRelative = 'true'
      }
      node.addEventListener('mouseenter', setVisible)
      node.addEventListener('mouseleave', setHidden)
      node.addEventListener('focusin', setVisible)
      node.addEventListener('focusout', setHidden)
    }
    badge.textContent = formatKeyCombo(current.keys)
    position()
    badge.style.opacity = show ? '1' : '0'
  }

  function setVisible() {
    show = true
    if (badge) badge.style.opacity = '1'
  }

  function setHidden() {
    show = false
    if (badge) badge.style.opacity = '0'
  }

  render()

  return {
    update(next: ShortcutHintOptions) {
      current = next
      render()
    },
    destroy() {
      node.removeEventListener('mouseenter', setVisible)
      node.removeEventListener('mouseleave', setHidden)
      node.removeEventListener('focusin', setVisible)
      node.removeEventListener('focusout', setHidden)
      if (node.dataset.shortcutHintRelative) {
        node.classList.remove('relative')
        delete node.dataset.shortcutHintRelative
      }
      badge?.remove()
      badge = null
    }
  }
}

/** Shared badge styling — muted kbd chip that lifts above the control. */
export const shortcutHintBadgeClass =
  'absolute z-20 inline-flex h-4 min-w-4 items-center justify-center rounded border border-border bg-surface px-1 font-mono text-[0.5625rem] leading-none text-dimmed shadow-sm transition-opacity duration-150'
