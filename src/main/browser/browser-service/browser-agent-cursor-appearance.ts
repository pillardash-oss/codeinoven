import { nativeTheme } from 'electron'
import { type AppConfig } from '../../../lib/types'
import {
  agentCursorAppearance,
  type AgentCursorAppearance
} from '../../../lib/browser/agent-cursor'

/**
 * What the agent cursor is drawn as, kept current without a config read per click.
 *
 * The cursor follows the app's theme, contrast level and UI scale, all three of which
 * the user can change while a turn is running. Theme is read live from Electron;
 * contrast and scale live in the config file, so the file is read once, cached, and
 * read again only after a write (an Appearance change) rather than on every pointer
 * move.
 */
export interface AgentCursorConfigSource {
  /** The stored app config, the same read every other config consumer makes. */
  getConfig: () => Promise<AppConfig>
  /** Notified after the config file is written, so the cached read is dropped. */
  onConfigWrite: (listener: () => void) => () => void
}

export class BrowserAgentCursorAppearance {
  private config: Promise<AppConfig> | null = null

  constructor(private readonly source: AgentCursorConfigSource) {
    this.source.onConfigWrite(() => {
      // A failed write still notifies, and a stale palette is not worth keeping, so
      // the next read goes back to the file either way.
      this.config = null
    })
  }

  /** The appearance to draw right now. */
  async current(): Promise<AgentCursorAppearance> {
    const config = await this.configRead()
    return agentCursorAppearance({
      dark: nativeTheme.shouldUseDarkColors,
      contrast: config.contrastLevel,
      appFontSize: config.appFontSize
    })
  }

  private configRead(): Promise<AppConfig> {
    if (!this.config) {
      const read = this.source.getConfig()
      this.config = read
      // A rejected read must not be cached, or the cursor could never recover from
      // one bad file.
      read.catch(() => {
        if (this.config === read) this.config = null
      })
    }
    return this.config
  }
}
