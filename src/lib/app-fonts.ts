/** Shared font choices and persisted ids for renderer and config validation. */
export const DEFAULT_APP_FONT_FAMILY = 'oven-box'

export const APP_FONT_OPTIONS = [
  { id: 'oven-box', label: 'Oven Box (default)' },
  { id: 'oven-mono', label: 'Oven Mono' },
  { id: 'jetbrains-mono', label: 'JetBrains Mono' },
  { id: 'system', label: 'System default' },
  { id: 'sf-mono', label: 'SF Mono' },
  { id: 'menlo', label: 'Menlo' },
  { id: 'monaco', label: 'Monaco' },
  { id: 'fira-code', label: 'Fira Code' }
]

/**
 * The families that answer the icons a monospace face does not carry.
 *
 * A Nerd Font replaces the Private Use Area with its own glyphs, and the terminal draws its
 * prompts, file trees and statuslines with them, so a face without those codepoints shows a
 * placeholder box for every icon a shell prints. They sit after the chosen face and before
 * the generic fallbacks: a patched family contributes exactly the glyphs the face is missing
 * and never displaces the face itself. Nothing here is bundled — these are the reader's own
 * installed fonts, both common Nerd Fonts names, and one that is absent is skipped silently.
 */
const NERD_FONT_ICONS = "'JetBrainsMono Nerd Font Mono', 'Symbols Nerd Font Mono'"

/** A mono stack: the chosen face, then the icon fonts, then the generic fallbacks. */
function monoStack(face: string, tail = 'ui-monospace, monospace'): string {
  return `${face}, ${NERD_FONT_ICONS}, ${tail}`
}

export const FONT_STACKS: Record<string, string> = {
  'oven-box': monoStack("'Oven Box', 'JetBrains Mono Variable'"),
  'oven-mono': monoStack("'Oven Mono', 'JetBrains Mono Variable'"),
  'jetbrains-mono': monoStack("'JetBrains Mono Variable'"),
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'sf-mono': monoStack("'SF Mono'", "ui-monospace, 'SFMono-Regular', Menlo, monospace"),
  menlo: monoStack('Menlo'),
  monaco: monoStack('Monaco'),
  'fira-code': monoStack("'Fira Code', 'JetBrains Mono Variable'")
}

export function normalizeAppFontFamily(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(FONT_STACKS, value)
    ? value
    : DEFAULT_APP_FONT_FAMILY
}
