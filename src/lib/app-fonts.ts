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

export const FONT_STACKS: Record<string, string> = {
  'oven-box': "'Oven Box', 'JetBrains Mono Variable', ui-monospace, monospace",
  'oven-mono': "'Oven Mono', 'JetBrains Mono Variable', ui-monospace, monospace",
  'jetbrains-mono':
    "'JetBrains Mono Variable', 'JetBrainsMono Nerd Font Mono', ui-monospace, monospace",
  system: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  'sf-mono': "'SF Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
  menlo: 'Menlo, ui-monospace, monospace',
  monaco: 'Monaco, ui-monospace, monospace',
  'fira-code': "'Fira Code', 'JetBrains Mono Variable', ui-monospace, monospace"
}

export function normalizeAppFontFamily(value: unknown): string {
  return typeof value === 'string' && Object.hasOwn(FONT_STACKS, value)
    ? value
    : DEFAULT_APP_FONT_FAMILY
}
