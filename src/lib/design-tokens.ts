import appCss from '../renderer/app.css?raw'

/**
 * The app's own design tokens and control rules, read from its stylesheet.
 *
 * An artifact is not given a palette of its own: it is composed from the same
 * tokens the app composes itself with, and the token catalog handed to the agent
 * (and the interactive-element rules the artifact's document applies) are read
 * from `src/renderer/app.css` itself. A redesign therefore reaches new artifacts
 * without the prompt being rewritten: change the tokens, or change how the app
 * shapes a button, and every artifact authored afterwards follows.
 *
 * The parsed text is small and read once per process, so both the prompt assembly
 * (main) and the artifact document (renderer) can ask for it on demand.
 */

/** Comments removed first, so prose braces and prose semicolons are never parsed. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '')
}

/**
 * The body of the first rule whose selector matches, with nested braces balanced.
 *
 * A stylesheet-level rule scanner rather than a CSS parser: the file is this
 * app's own, its blocks are flat where this reads them, and a parser dependency
 * for two lookups would be the larger risk.
 */
function blockBody(css: string, selector: RegExp): string | null {
  const match = selector.exec(css)
  if (!match || match.index === undefined) return null
  const open = css.indexOf('{', match.index)
  if (open < 0) return null
  let depth = 0
  for (let index = open; index < css.length; index += 1) {
    const character = css[index]
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, index)
    }
  }
  return null
}

/** One custom property per entry, in the order the stylesheet declares them. */
function declarations(body: string | null): Map<string, string> {
  const found = new Map<string, string>()
  if (!body) return found
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/gu)) {
    found.set(match[1], match[2].replace(/\s+/gu, ' ').trim())
  }
  return found
}

const css = stripComments(appCss)
/** Light-mode defaults; the shipped palette every token starts from. */
const light = declarations(blockBody(css, /@theme\s*\{/u))
/** Dark-mode overrides, declared on the app's `.dark` root. */
const dark = declarations(blockBody(css, /\.dark\s*\{/u))

export interface AppDesignToken {
  /** The custom property, e.g. `--color-surface`. */
  name: string
  /** Its value in the shipped (light) palette, verbatim. */
  light: string
  /** Its value under `.dark`, when the app overrides it. */
  dark: string | null
}

/**
 * Every token the app declares, with the value it takes in each scheme.
 *
 * The terminal palette is left out: an artifact is a page in a conversation, not
 * a terminal, and handing over sixteen colours no artifact can use would bury
 * the ones it can.
 */
export function appDesignTokens(): AppDesignToken[] {
  return [...light.entries()]
    .filter(([name]) => !name.startsWith('--color-terminal-'))
    .map(([name, value]) => {
      const darkValue = dark.get(name)
      return { name, light: value, dark: darkValue && darkValue !== value ? darkValue : null }
    })
}

/** The catalog as the agent reads it: one token per line, both schemes. */
export function appDesignTokenCatalog(): string {
  return appDesignTokens()
    .map((token) => {
      const darkNote = token.dark === null ? '' : ` (dark: ${token.dark})`
      return `${token.name}: ${token.light}${darkNote}`
    })
    .join('\n')
}

/**
 * The app's own rules for interactive elements, verbatim.
 *
 * These are emitted into an artifact's isolated document so a button, input,
 * select or dialog inside an artifact is shaped exactly the way the app shapes
 * its own, including whatever corner or focus treatment the app uses today.
 */
export function appInteractiveElementRules(): string {
  const selectors = [
    /:where\(button[^{}]*\{[^{}]*\}/gu,
    /:where\(input[^{}]*\{[^{}]*\}/gu
  ]
  const rules = selectors.flatMap((selector) => css.match(selector) ?? [])
  return rules.join('\n')
}

/** Ready-made text for the artifact guidance; empty when the stylesheet is unreadable. */
export const APP_DESIGN_TOKEN_CATALOG = appDesignTokenCatalog()
