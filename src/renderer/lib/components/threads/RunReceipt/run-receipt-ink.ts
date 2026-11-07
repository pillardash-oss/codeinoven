/**
 * The ink a receipt uses for a status it has to state in words.
 *
 * `--color-danger` and `--color-warning` at full strength are marks, not body
 * text: on either surface they fall under the 4.5:1 a string has to clear. Mixing
 * them toward the foreground keeps the hue that says "failed" while raising the
 * contrast past the floor, and it does so per theme because both halves of the
 * mix are semantic tokens. `tests/renderer/run-receipt-contrast.test.ts` computes
 * the resulting ratios from the real token values rather than trusting this note.
 */
const MIX = 55

export const STATUS_INK = {
  danger: `color-mix(in srgb, var(--color-danger) ${MIX}%, var(--color-foreground))`,
  warning: `color-mix(in srgb, var(--color-warning) ${MIX}%, var(--color-foreground))`
} as const

/** The share of the status token the ink keeps, exported so a test asserts the same number. */
export const STATUS_INK_MIX_PERCENT = MIX
