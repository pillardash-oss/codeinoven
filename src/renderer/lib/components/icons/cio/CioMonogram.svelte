<script lang="ts">
  import type { SVGAttributes } from 'svelte/elements'

  /**
   * The app's monogram, drawn as a glyph so any surface can render the brand at
   * icon scale.
   *
   * It is the same mark the icon assets carry (`icon-mark.svg`, `icon-mono.svg`):
   * the C, the oven door and its gold handle. It is inlined rather than loaded
   * from a file because a trace row prints it dozens of times per turn, and
   * because the strokes have to pick up the row's own ink colour as it fades
   * with hover. Only the handle keeps a colour of its own, from the accent
   * token, exactly as the brand does everywhere else.
   */
  interface Props extends Omit<SVGAttributes<SVGSVGElement>, 'size'> {
    size?: number | string
  }

  let { size = 16, class: className = '', ...rest }: Props = $props()

  /** A glyph is decoration unless the call site names it for a screen reader. */
  let named = $derived(rest.role === 'img' || rest['aria-label'] !== undefined)
</script>

<!-- The box starts at 3, not 0: the C's left tip overhangs its own arc, and
     centring the drawn ink is what keeps the mark from reading off-centre. -->
<svg
  xmlns="http://www.w3.org/2000/svg"
  viewBox="3 0 96 96"
  width={size}
  height={size}
  fill="none"
  class={className}
  aria-hidden={named ? undefined : 'true'}
  {...rest}
>
  <path
    d="M49 17a31 31 0 1 0 0 62"
    stroke="currentColor"
    stroke-width="8"
    stroke-linecap="square"
    stroke-linejoin="miter"
  />
  <path d="M61 23h23v50H61z" stroke="currentColor" stroke-width="7" stroke-linejoin="miter" />
  <rect x="58" y="45" width="29" height="6" fill="currentColor" />
  <circle cx="84" cy="48" r="5" fill="var(--color-accent)" />
</svg>
