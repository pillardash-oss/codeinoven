// Ported from the `thinking-orbs` package (MIT, Jakub Antalik), React removed.
// See ./LICENSE.md. The public types stay identical to upstream so the engine
// and presets can be dropped in verbatim.

/**
 * The nine shipped states — each a hand-tuned animation:
 * - `working`    — particles on tilted orbits
 * - `searching`  — a scan meridian sweeps a dotted globe
 * - `solving`    — bands scramble in quarter turns, then click back
 * - `listening`  — a waveform rolls through latitude rings
 * - `connecting` — a constellation wires itself, packets running the edges
 * - `weaving`    — three strands plait around the sphere
 * - `composing`  — an undulating multi-band sash
 * - `breathing`  — a face-on ring slowly morphing
 * - `shaping`    — a dotted outline morphs circle → triangle → square
 */
export type OrbState =
  | 'working'
  | 'searching'
  | 'solving'
  | 'listening'
  | 'connecting'
  | 'weaving'
  | 'composing'
  | 'breathing'
  | 'shaping'

/**
 * Rendered size in CSS pixels. Exactly two tuned presets ship:
 * 64 (chat-avatar scale) and 20 (inline-text scale). Each size carries
 * its own dot count, dot size and speed tuning — they are separate
 * designs, not a scale factor.
 */
export type OrbSize = 64 | 20

/**
 * Theme mode.
 *
 * - `auto` (default) resolves from the host project's painted theme: the app
 *   paints a `dark` class on `<html>`, which `ThinkingOrb.svelte` reads
 *   through the renderer's `schemeState`.
 * - `dark` / `light` pin the palette regardless of context.
 *
 * Dark renders light ink on the transparent canvas (for dark
 * backgrounds); light renders dark ink (for light backgrounds).
 */
export type OrbTheme = 'auto' | 'dark' | 'light'
