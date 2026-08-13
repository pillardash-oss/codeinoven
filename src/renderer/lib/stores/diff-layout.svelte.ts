import { APP_SLUG } from '$shared/brand'

export type DiffLayout = 'vertical' | 'horizontal'

const STORAGE_KEY = `${APP_SLUG}.diffLayout.v1`

function load(): DiffLayout {
  if (typeof window === 'undefined') return 'vertical'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'vertical' || raw === 'horizontal') return raw
  } catch {
    // Storage unavailable — fall back to the default layout.
  }
  return 'vertical'
}

/** Action-specific title for the toggle, describing what clicking does. */
export function diffLayoutToggleLabel(layout: DiffLayout): string {
  return layout === 'vertical' ? 'Show diffs side by side' : 'Stack diffs vertically'
}

/**
 * Shared diff layout preference used by the file diff viewer and the working
 * trace's inline diffs. `vertical` stacks diff blocks on top of each other;
 * `horizontal` arranges them side by side. Whatever the user last selected is
 * applied everywhere diffs are rendered.
 */
class DiffLayoutStore {
  layout = $state<DiffLayout>(load())

  setLayout(layout: DiffLayout): void {
    this.layout = layout
    this.persist()
  }

  toggle(): void {
    this.setLayout(this.layout === 'vertical' ? 'horizontal' : 'vertical')
  }

  persist(): void {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(STORAGE_KEY, this.layout)
    } catch {
      // Diff layout is optional; unavailable storage must not break the app.
    }
  }
}

export const diffLayoutState = new DiffLayoutStore()
