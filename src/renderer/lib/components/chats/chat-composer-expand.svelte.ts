import {
  composerConversationPane,
  expandedComposerWidth,
  measureComposerExpansion
} from './chat-composer-expand'

export interface ComposerExpansionOptions {
  /** The composer root element, resolved lazily: it mounts after the
   *  controller is created. */
  getComposer: () => HTMLElement | null
}

/**
 * The composer's maximize control: one boolean for the UI to toggle plus the
 * measured width of the expanded composer.
 *
 * The width is written straight onto the composer as the
 * `--composer-expanded-width` custom property rather than held as state, so
 * re-measuring never enters the reactive graph   a pane that resizes can only
 * ever change the composer's own box, never anything it renders.
 *
 * The host clip is the conversation pane, which resizes with the sidebars and
 * the terminal split (no `resize` event), so the pane is observed directly for
 * as long as the composer stays maximized.
 */
export function createComposerExpansion(options: ComposerExpansionOptions) {
  let maximized = $state(false)

  $effect(() => {
    const composer = options.getComposer()
    if (!composer) return
    const clearWidth = (): void => {
      composer.style.removeProperty('--composer-expanded-width')
    }
    if (!maximized) {
      clearWidth()
      return
    }

    const measure = (): void => {
      const bounds = measureComposerExpansion(composer)
      if (!bounds) {
        clearWidth()
        return
      }
      composer.style.setProperty('--composer-expanded-width', `${expandedComposerWidth(bounds)}px`)
    }

    measure()
    const observer = new ResizeObserver(measure)
    const pane = composerConversationPane(composer)
    if (pane) observer.observe(pane)
    // Fallback for the hosts that render the composer outside a conversation
    // region: the window is the only box left that can clip the expansion.
    else window.addEventListener('resize', measure)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      clearWidth()
    }
  })

  function toggle(): void {
    maximized = !maximized
  }

  return {
    get maximized(): boolean {
      return maximized
    },
    toggle
  }
}
