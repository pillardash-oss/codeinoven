import type { ITheme } from 'ghostty-web'

/** One app CSS token, trimmed, as a terminal palette colour. */
function tokenColor(styles: CSSStyleDeclaration, token: string): string {
  return styles.getPropertyValue(token).trim()
}

/**
 * The terminal palette, read from the app's live CSS tokens.
 *
 * Every terminal surface in the app paints itself with the same tokens, so a
 * terminal always matches the active theme and appearance settings instead of
 * shipping a palette of its own.
 */
export function terminalThemeFromTokens(): ITheme {
  const styles = getComputedStyle(document.documentElement)
  return {
    background: tokenColor(styles, '--color-terminal-background'),
    foreground: tokenColor(styles, '--color-terminal-foreground'),
    cursor: tokenColor(styles, '--color-terminal-cursor'),
    selectionBackground: tokenColor(styles, '--color-terminal-selection'),
    black: tokenColor(styles, '--color-terminal-black'),
    red: tokenColor(styles, '--color-terminal-red'),
    green: tokenColor(styles, '--color-terminal-green'),
    yellow: tokenColor(styles, '--color-terminal-yellow'),
    blue: tokenColor(styles, '--color-terminal-blue'),
    magenta: tokenColor(styles, '--color-terminal-magenta'),
    cyan: tokenColor(styles, '--color-terminal-cyan'),
    white: tokenColor(styles, '--color-terminal-white'),
    brightBlack: tokenColor(styles, '--color-terminal-bright-black'),
    brightRed: tokenColor(styles, '--color-terminal-bright-red'),
    brightGreen: tokenColor(styles, '--color-terminal-bright-green'),
    brightYellow: tokenColor(styles, '--color-terminal-bright-yellow'),
    brightBlue: tokenColor(styles, '--color-terminal-bright-blue'),
    brightMagenta: tokenColor(styles, '--color-terminal-bright-magenta'),
    brightCyan: tokenColor(styles, '--color-terminal-bright-cyan'),
    brightWhite: tokenColor(styles, '--color-terminal-bright-white')
  }
}
