import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { STATUS_INK_MIX_PERCENT } from '../../src/renderer/lib/components/threads/RunReceipt/run-receipt-ink'

/**
 * Contrast, computed from the app's real semantic tokens.
 *
 * A receipt is a wall of small strings, so every one of them has to clear the
 * body-text floor in both themes, and `--color-dimmed` is reserved for marks.
 * These cases read the token values out of `src/renderer/app.css` and compute the
 * ratios rather than trusting a screenshot: a theme tweak that drops a string
 * under 4.5:1 fails here, which is the moment to fix it.
 */

interface Rgb {
  r: number
  g: number
  b: number
}

function parseHex(hex: string): Rgb {
  const value = hex.replace('#', '')
  const full =
    value.length === 3
      ? value
          .split('')
          .map((character) => character + character)
          .join('')
      : value
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16)
  }
}

function relativeLuminance({ r, g, b }: Rgb): number {
  const channel = (value: number): number => {
    const scaled = value / 255
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

function contrast(foreground: Rgb, background: Rgb): number {
  const first = relativeLuminance(foreground)
  const second = relativeLuminance(background)
  const lighter = Math.max(first, second)
  const darker = Math.min(first, second)
  return (lighter + 0.05) / (darker + 0.05)
}

/** A status token mixed toward the foreground, the way `color-mix` does it. */
function mix(status: Rgb, foreground: Rgb, percent: number): Rgb {
  const weight = percent / 100
  return {
    r: Math.round(status.r * weight + foreground.r * (1 - weight)),
    g: Math.round(status.g * weight + foreground.g * (1 - weight)),
    b: Math.round(status.b * weight + foreground.b * (1 - weight))
  }
}

const css = readFileSync(join(process.cwd(), 'src/renderer/app.css'), 'utf8')

/** Read one custom property's first hex value, which is the light theme's. */
function lightToken(name: string): Rgb {
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'u').exec(css)
  if (!match?.[1]) throw new Error(`Token ${name} is not a hex value`)
  return parseHex(match[1])
}

/** Read a token inside the `.dark` block. */
function darkToken(name: string): Rgb {
  const darkStart = css.indexOf('.dark {')
  if (darkStart === -1) throw new Error('No .dark theme block')
  const block = css.slice(darkStart)
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`, 'u').exec(block)
  if (!match?.[1]) throw new Error(`Token ${name} is not declared in .dark`)
  return parseHex(match[1])
}

const THEMES = [
  { name: 'light', token: lightToken },
  { name: 'dark', token: darkToken }
] as const

describe('run receipt contrast', () => {
  for (const theme of THEMES) {
    it(`clears 4.5:1 for every content string in ${theme.name}`, () => {
      const surface = theme.token('--color-surface')
      expect(contrast(theme.token('--color-foreground'), surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(theme.token('--color-muted'), surface)).toBeGreaterThanOrEqual(4.5)
      const failed = mix(theme.token('--color-danger'), theme.token('--color-foreground'), STATUS_INK_MIX_PERCENT)
      const stopped = mix(
        theme.token('--color-warning'),
        theme.token('--color-foreground'),
        STATUS_INK_MIX_PERCENT
      )
      expect(contrast(failed, surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(stopped, surface)).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('keeps --color-dimmed out of the receipt, because it fails the floor', () => {
    // The token is a mark colour by design, and this records why: it is below the
    // body-text floor on its own surface in both themes.
    expect(contrast(lightToken('--color-dimmed'), lightToken('--color-surface'))).toBeLessThan(4.5)
    expect(contrast(darkToken('--color-dimmed'), darkToken('--color-surface'))).toBeLessThan(4.5)
  })
})
