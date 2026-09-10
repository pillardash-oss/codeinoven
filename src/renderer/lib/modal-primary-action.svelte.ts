/**
 * Shared "primary action" pipeline for modal overlays.
 *
 * Every modal (Modal, DockableModal) registers a resolver for its primary
 * action on a LIFO stack while open, so ⌘/Ctrl+Enter — the "run the primary
 * action" shortcut — activates the primary action of exactly the topmost
 * registered modal: the one that is in focus. The resolver locates the
 * primary button inside the modal's own panel using the shared selector
 * chain:
 *
 *   1. `[data-modal-primary]` — explicit opt-in on the action button
 *   2. `[data-modal-footer] button[type="submit"]` — the form-submit affordance
 *   3. `[data-modal-footer] .bg-primary / .bg-danger` — styled footer buttons
 *   4. the last enabled footer button
 *   5. any enabled `.bg-primary / .bg-danger` button in the panel
 *
 * Only genuinely visible, enabled buttons activate, and the shortcut yields
 * to focused native form semantics (a focused submit button already fires on
 * Enter) and to other chord owners (chat composer send, git commit).
 */

type PrimaryActionResolver = () => boolean

const resolvers: PrimaryActionResolver[] = []

/** Register a modal's primary-action resolver. Returns an unsubscribe function. */
export function registerModalPrimaryAction(resolver: PrimaryActionResolver): () => void {
  resolvers.push(resolver)
  let removed = false
  return () => {
    if (removed) return
    removed = true
    const index = resolvers.indexOf(resolver)
    if (index !== -1) resolvers.splice(index, 1)
  }
}

/**
 * Activate the topmost registered modal's primary action. Returns whether a
 * modal was found and its resolver claimed the shortcut.
 */
export function activateTopModalPrimaryAction(): boolean {
  for (let index = resolvers.length - 1; index >= 0; index--) {
    if (resolvers[index]()) return true
  }
  return false
}

const INPUT_FIELD_SELECTOR = [
  'input:not([type="hidden"]):not([disabled]):not([readonly])',
  'textarea:not([disabled]):not([readonly])',
  'select:not([disabled])',
  '[contenteditable="true"]:not([aria-disabled="true"])'
].join(',')

export const PRIMARY_BUTTON_SELECTOR =
  'button.bg-primary:not([disabled]), button.bg-danger:not([disabled])'

export function isFocusableTarget(element: HTMLElement): boolean {
  return (
    element.getAttribute('aria-disabled') !== 'true' &&
    !element.closest('[hidden], [inert], [aria-hidden="true"]') &&
    element.checkVisibility()
  )
}

function firstFocusable(panel: HTMLElement, selector: string): HTMLElement | undefined {
  return Array.from(panel.querySelectorAll<HTMLElement>(selector)).find(isFocusableTarget)
}

/** Resolve a panel's primary action button via the shared selector chain. */
export function findPanelPrimaryAction(panel: HTMLElement): HTMLElement | undefined {
  const footerActions = Array.from(
    panel.querySelectorAll<HTMLElement>('[data-modal-footer] button:not([disabled])')
  ).filter(isFocusableTarget)

  return (
    firstFocusable(panel, '[data-modal-primary]:not([disabled])') ??
    firstFocusable(panel, '[data-modal-footer] button[type="submit"]:not([disabled])') ??
    firstFocusable(panel, `[data-modal-footer] :is(${PRIMARY_BUTTON_SELECTOR})`) ??
    footerActions.at(-1) ??
    firstFocusable(panel, PRIMARY_BUTTON_SELECTOR)
  )
}

/**
 * True when the current focus means Enter already activates the primary
 * action natively (a focused submit button inside a form), so the pipeline
 * must not double-fire it.
 */
export function focusOwnsEnter(panel: HTMLElement): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  if (!panel.contains(active)) return false
  return active.matches('button[type="submit"]')
}

/**
 * True when the focused element is a text field whose Enter behavior belongs
 * to the field (multi-line editor, chat composer) rather than the modal — the
 * pipeline still claims ⌘Enter there (that is its main purpose), but plain
 * Enter never leaks.
 */
export function isTextFieldFocused(panel: HTMLElement): boolean {
  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return false
  if (!panel.contains(active)) return false
  return active.matches(INPUT_FIELD_SELECTOR)
}
